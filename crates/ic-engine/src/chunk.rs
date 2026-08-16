//! AST-boundary chunking over tree-sitter trees.
//!
//! Declarations come from per-language queries; token counts come from the
//! committed `bge-small-en-v1.5` tokeniser. Files without a grammar, timed-out
//! parses, and `ERROR` ranges fall back to line windows so content is never
//! silently dropped.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;

use thiserror::Error;
use tree_sitter::{Node, Parser, Query, QueryCursor, StreamingIterator, Tree};

use crate::parse::Language;
use crate::tokenise;
use crate::walk::{FileRecord, RepoManifest};

/// Options controlling chunk size and parse budgets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkOptions {
    /// Hard ceiling. No emitted chunk exceeds this. Default 512, the model's window.
    pub max_tokens: usize,
    /// Chunks below this merge with the next sibling where one exists. Default 64.
    pub min_tokens: usize,
    /// Lines repeated at the start of a chunk that had to be split mid-declaration. Default 2.
    pub split_overlap_lines: usize,
    /// Per-file parse deadline. Default 5000.
    pub parse_timeout_ms: u64,
}

impl Default for ChunkOptions {
    fn default() -> Self {
        Self {
            max_tokens: 512,
            min_tokens: 64,
            split_overlap_lines: 2,
            parse_timeout_ms: 5000,
        }
    }
}

/// Kind written to `chunks.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkKind {
    Function,
    Method,
    Class,
    Struct,
    Interface,
    TypeAlias,
    Imports,
    /// A whole file with no grammar, or the remainder of one that could not be parsed.
    LineWindow,
}

impl ChunkKind {
    /// Written to `chunks.kind`, for example `function`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Interface => "interface",
            Self::TypeAlias => "type_alias",
            Self::Imports => "imports",
            Self::LineWindow => "line_window",
        }
    }

    const fn is_type_level(self) -> bool {
        matches!(
            self,
            Self::Class | Self::Struct | Self::Interface | Self::TypeAlias
        )
    }
}

/// One embeddable span of a source file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// One-based and inclusive, matching `chunks.start_line` and `chunks.end_line`.
    pub start_line: u32,
    pub end_line: u32,
    /// The declared name, for example `UserService.create`. None for `Imports` and `LineWindow`.
    pub symbol: Option<String>,
    pub kind: ChunkKind,
    pub content: String,
    pub token_count: u32,
}

/// Failures that abort chunking (not soft per-file fallbacks).
#[derive(Debug, Error)]
pub enum ChunkError {
    /// Reserved for callers that require a grammar; [`chunk_file`] line-windows instead.
    #[error("no grammar for {0}")]
    UnsupportedLanguage(String),
    /// Reserved; timeouts are counted in [`ChunkStats`] and line-windowed.
    #[error("parsing {path} exceeded {timeout_ms}ms")]
    ParseTimeout { path: String, timeout_ms: u64 },
    #[error("tokeniser unavailable: {0}")]
    Tokeniser(String),
}

/// Aggregate counters for a manifest run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChunkStats {
    pub files_parsed: usize,
    pub files_line_windowed: usize,
    pub files_timed_out: usize,
    pub chunks_emitted: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileOutcome {
    Parsed,
    LineWindowed,
    TimedOut,
}

/// Chunks one file. Never panics on malformed input; a file that cannot be parsed at all
/// yields line windows rather than an error.
///
/// # Errors
///
/// Returns [`ChunkError::Tokeniser`] when the committed tokeniser cannot be loaded or encode.
pub fn chunk_file(
    source: &str,
    language: Option<Language>,
    options: &ChunkOptions,
) -> Result<Vec<Chunk>, ChunkError> {
    let (chunks, _) = chunk_file_inner(source, language, options)?;
    Ok(chunks)
}

fn chunk_file_inner(
    source: &str,
    language: Option<Language>,
    options: &ChunkOptions,
) -> Result<(Vec<Chunk>, FileOutcome), ChunkError> {
    let Some(language) = language else {
        let chunks = line_windows(source, options)?;
        return Ok((chunks, FileOutcome::LineWindowed));
    };

    let mut parser = Parser::new();
    if parser.set_language(&language.grammar()).is_err() {
        let chunks = line_windows(source, options)?;
        return Ok((chunks, FileOutcome::LineWindowed));
    }

    // Contract: pathological files cost one file, not the run.
    // tree-sitter treats 0 as "no timeout"; a 0ms deadline means 1µs so the
    // timeout path stays testable without disabling the guard.
    let timeout_micros = match options.parse_timeout_ms.saturating_mul(1_000) {
        0 => 1,
        micros => micros,
    };
    #[allow(deprecated)]
    parser.set_timeout_micros(timeout_micros);

    let Some(tree) = parser.parse(source, None) else {
        let chunks = line_windows(source, options)?;
        return Ok((chunks, FileOutcome::TimedOut));
    };

    let chunks = chunk_tree(source, language, &tree, options)?;
    Ok((enforce_token_ceiling(chunks, options)?, FileOutcome::Parsed))
}

/// Streams chunks for a whole manifest, one file at a time, bounded by `concurrency`.
/// The channel is bounded so a slow consumer applies backpressure instead of growing the heap.
///
/// # Errors
///
/// Propagates sink errors and tokeniser failures from workers.
#[allow(clippy::type_complexity)] // sink signature is part of the public contract
pub fn chunk_manifest(
    manifest: &RepoManifest,
    options: &ChunkOptions,
    concurrency: usize,
    sink: &mut dyn FnMut(&FileRecord, Vec<Chunk>) -> Result<(), ChunkError>,
) -> Result<ChunkStats, ChunkError> {
    let concurrency = concurrency.max(1);
    let bound = concurrency.saturating_mul(2).max(1);
    let (job_tx, job_rx) = mpsc::sync_channel::<FileRecord>(bound);
    let (res_tx, res_rx) = mpsc::sync_channel::<Result<WorkItem, ChunkError>>(bound);

    let job_rx = Arc::new(Mutex::new(job_rx));
    let root = manifest.root.clone();
    let options = options.clone();
    let files = manifest.files.clone();

    thread::scope(|scope| {
        for _ in 0..concurrency {
            let job_rx = Arc::clone(&job_rx);
            let res_tx = res_tx.clone();
            let root = root.clone();
            let options = options.clone();
            scope.spawn(move || worker_loop(&job_rx, &res_tx, &root, &options));
        }
        drop(res_tx);

        scope.spawn(move || {
            for file in files {
                if job_tx.send(file).is_err() {
                    break;
                }
            }
        });

        let mut stats = ChunkStats::default();
        for item in res_rx {
            let item = item?;
            match item.outcome {
                FileOutcome::Parsed => stats.files_parsed += 1,
                FileOutcome::LineWindowed => stats.files_line_windowed += 1,
                FileOutcome::TimedOut => {
                    stats.files_timed_out += 1;
                    stats.files_line_windowed += 1;
                }
            }
            stats.chunks_emitted += item.chunks.len();
            sink(&item.file, item.chunks)?;
        }
        Ok(stats)
    })
}

struct WorkItem {
    file: FileRecord,
    chunks: Vec<Chunk>,
    outcome: FileOutcome,
}

fn worker_loop(
    job_rx: &Mutex<mpsc::Receiver<FileRecord>>,
    res_tx: &SyncSender<Result<WorkItem, ChunkError>>,
    root: &Path,
    options: &ChunkOptions,
) {
    loop {
        let file = {
            let Ok(guard) = job_rx.lock() else {
                break;
            };
            match guard.recv() {
                Ok(file) => file,
                Err(_) => break,
            }
        };

        let path = join_manifest_path(root, &file.path);
        let source = fs::read_to_string(&path).unwrap_or_default();
        let language = Language::from_path(&file.path)
            .or_else(|| source.lines().next().and_then(Language::from_shebang));

        let result =
            chunk_file_inner(&source, language, options).map(|(chunks, outcome)| WorkItem {
                file,
                chunks,
                outcome,
            });

        if res_tx.send(result).is_err() {
            break;
        }
    }
}

fn join_manifest_path(root: &Path, relative: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        out.push(part);
    }
    out
}

#[derive(Debug, Clone)]
struct DeclSpan {
    start_byte: usize,
    end_byte: usize,
    kind: ChunkKind,
    symbol: Option<String>,
    parent_key: Option<usize>,
    is_import: bool,
}

fn chunk_tree(
    source: &str,
    language: Language,
    tree: &Tree,
    options: &ChunkOptions,
) -> Result<Vec<Chunk>, ChunkError> {
    let query = Query::new(&language.grammar(), language.query_source())
        .map_err(|err| ChunkError::Tokeniser(format!("query compile failed: {err}")))?;

    let mut decls = collect_declarations(source, tree.root_node(), &query);
    decls = prefer_innermost(&decls);
    expand_leading_trivia(source, tree.root_node(), &mut decls);

    let (imports, mut rest): (Vec<_>, Vec<_>) = decls.into_iter().partition(|d| d.is_import);
    let mut pending: Vec<PendingChunk> = Vec::new();

    if let Some(import_chunk) = collapse_imports(source, &imports)? {
        pending.push(import_chunk);
    }

    rest.sort_by_key(|d| (d.start_byte, d.end_byte));
    for decl in &rest {
        pending.extend(declaration_to_pending(source, decl, options)?);
    }

    let covered = covered_ranges(&pending);
    for (err_start, err_end) in error_ranges(tree.root_node()) {
        if range_overlaps_any(err_start, err_end, &covered) {
            continue;
        }
        let slice = byte_slice(source, err_start, err_end);
        pending.extend(slice_to_line_windows(source, slice, err_start, options)?);
    }

    pending = merge_small(pending, options)?;
    pending.sort_by_key(|p| (p.start_byte, p.end_byte));

    pending
        .into_iter()
        .map(|p| {
            Ok(Chunk {
                start_line: p.start_line,
                end_line: p.end_line.max(p.start_line),
                symbol: p.symbol,
                kind: p.kind,
                content: p.content,
                token_count: p.token_count,
            })
        })
        .collect()
}

fn collect_declarations(source: &str, root: Node<'_>, query: &Query) -> Vec<DeclSpan> {
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, source.as_bytes());
    let capture_names = query.capture_names();

    let mut decls = Vec::new();
    while let Some(m) = matches.next() {
        let mut decl_node: Option<Node<'_>> = None;
        let mut name_node: Option<Node<'_>> = None;
        let mut is_import = false;

        for capture in m.captures {
            let Some(name) = capture_names.get(capture.index as usize) else {
                continue;
            };
            match *name {
                "declaration" => decl_node = Some(capture.node),
                "import" => {
                    is_import = true;
                    decl_node = Some(capture.node);
                }
                "name" => name_node = Some(capture.node),
                _ => {}
            }
        }

        let Some(node) = decl_node else {
            continue;
        };
        let kind = if is_import {
            ChunkKind::Imports
        } else {
            kind_from_node(node)
        };
        let symbol = name_node.and_then(|n| n.utf8_text(source.as_bytes()).ok().map(str::to_owned));
        let symbol = qualify_symbol(source, node, kind, symbol);

        decls.push(DeclSpan {
            start_byte: node.start_byte(),
            end_byte: node.end_byte(),
            kind,
            symbol,
            parent_key: enclosing_type_key(node),
            is_import,
        });
    }
    decls
}

fn kind_from_node(node: Node<'_>) -> ChunkKind {
    let kind = node.kind();
    match kind {
        "method_definition" | "method_declaration" | "abstract_method_signature" => {
            ChunkKind::Method
        }
        "function_declaration"
        | "generator_function_declaration"
        | "function_definition"
        | "function_item" => {
            if is_method_context(node) {
                ChunkKind::Method
            } else {
                ChunkKind::Function
            }
        }
        "class_declaration" | "abstract_class_declaration" | "class_definition" | "impl_item" => {
            ChunkKind::Class
        }
        "struct_item" | "union_item" => ChunkKind::Struct,
        "interface_declaration" | "trait_item" => ChunkKind::Interface,
        "type_alias_declaration" | "type_item" | "enum_declaration" | "enum_item" => {
            ChunkKind::TypeAlias
        }
        "type_declaration" => go_type_kind(node),
        "decorated_definition" => node
            .child_by_field_name("definition")
            .map_or(ChunkKind::Function, kind_from_node),
        _ => {
            if kind.contains("method") {
                ChunkKind::Method
            } else if kind.contains("class") {
                ChunkKind::Class
            } else if kind.contains("struct") {
                ChunkKind::Struct
            } else if kind.contains("interface") || kind.contains("trait") {
                ChunkKind::Interface
            } else {
                ChunkKind::Function
            }
        }
    }
}

fn go_type_kind(node: Node<'_>) -> ChunkKind {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind() != "type_spec" {
            continue;
        }
        if let Some(ty) = child.child_by_field_name("type") {
            return match ty.kind() {
                "struct_type" => ChunkKind::Struct,
                "interface_type" => ChunkKind::Interface,
                _ => ChunkKind::TypeAlias,
            };
        }
    }
    ChunkKind::TypeAlias
}

fn is_method_context(node: Node<'_>) -> bool {
    let mut parent = node.parent();
    while let Some(p) = parent {
        match p.kind() {
            "class_body" | "class_declaration" | "impl_item" | "declaration_list"
            | "interface_body" | "trait_item" => return true,
            "source_file" | "program" | "module" => return false,
            _ => parent = p.parent(),
        }
    }
    false
}

fn enclosing_type_key(node: Node<'_>) -> Option<usize> {
    let mut parent = node.parent();
    while let Some(p) = parent {
        match p.kind() {
            "class_declaration"
            | "abstract_class_declaration"
            | "class_definition"
            | "impl_item"
            | "trait_item"
            | "interface_declaration"
            | "struct_item" => return Some(p.start_byte()),
            "source_file" | "program" | "module" => return None,
            _ => parent = p.parent(),
        }
    }
    None
}

fn qualify_symbol(
    source: &str,
    node: Node<'_>,
    kind: ChunkKind,
    name: Option<String>,
) -> Option<String> {
    let name = name?;
    if kind != ChunkKind::Method {
        return Some(name);
    }
    let mut parent = node.parent();
    while let Some(p) = parent {
        if let Some(parent_name) = type_name_of(source, p) {
            return Some(format!("{parent_name}.{name}"));
        }
        if matches!(p.kind(), "source_file" | "program" | "module") {
            break;
        }
        parent = p.parent();
    }
    Some(name)
}

fn type_name_of(source: &str, node: Node<'_>) -> Option<String> {
    match node.kind() {
        "class_declaration"
        | "abstract_class_declaration"
        | "class_definition"
        | "interface_declaration"
        | "struct_item"
        | "trait_item"
        | "enum_item"
        | "type_item" => node
            .child_by_field_name("name")
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())
            .map(str::to_owned),
        "impl_item" => node
            .child_by_field_name("type")
            .and_then(|n| n.utf8_text(source.as_bytes()).ok())
            .map(|s| {
                s.split_whitespace()
                    .last()
                    .map_or_else(|| s.to_owned(), str::to_owned)
            }),
        _ => None,
    }
}

fn prefer_innermost(decls: &[DeclSpan]) -> Vec<DeclSpan> {
    decls
        .iter()
        .filter(|d| {
            if d.is_import {
                return true;
            }
            !decls.iter().any(|other| {
                !other.is_import
                    && other.start_byte >= d.start_byte
                    && other.end_byte <= d.end_byte
                    && (other.start_byte > d.start_byte || other.end_byte < d.end_byte)
            })
        })
        .cloned()
        .collect()
}

fn expand_leading_trivia(source: &str, root: Node<'_>, decls: &mut [DeclSpan]) {
    for decl in decls.iter_mut() {
        if decl.is_import {
            continue;
        }
        let Some(node) = node_at_byte(root, decl.start_byte, decl.end_byte) else {
            continue;
        };
        let mut start = decl.start_byte;
        let mut current = node;

        loop {
            let mut prev = current.prev_sibling();
            while let Some(sib) = prev {
                if is_leading_trivia(sib) {
                    start = sib.start_byte();
                    prev = sib.prev_sibling();
                } else {
                    break;
                }
            }
            let Some(parent) = current.parent() else {
                break;
            };
            if is_export_wrapper(parent) && parent.start_byte() <= start {
                start = start.min(parent.start_byte());
                current = parent;
                continue;
            }
            break;
        }

        while start > 0 {
            match source.as_bytes().get(start - 1).copied() {
                Some(b' ' | b'\t') => start -= 1,
                _ => break,
            }
        }
        decl.start_byte = start;
    }
}

fn is_leading_trivia(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "comment"
            | "line_comment"
            | "block_comment"
            | "decorator"
            | "attribute_item"
            | "inner_attribute_item"
    )
}

fn is_export_wrapper(node: Node<'_>) -> bool {
    node.kind() == "export_statement"
}

fn node_at_byte(root: Node<'_>, start: usize, end: usize) -> Option<Node<'_>> {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.start_byte() == start && node.end_byte() == end {
            return Some(node);
        }
        if node.start_byte() <= start && node.end_byte() >= end {
            for i in (0..node.child_count()).rev() {
                if let Some(child) = node.child(i) {
                    stack.push(child);
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
struct PendingChunk {
    start_byte: usize,
    end_byte: usize,
    start_line: u32,
    end_line: u32,
    symbol: Option<String>,
    kind: ChunkKind,
    content: String,
    token_count: u32,
    parent_key: Option<usize>,
}

fn collapse_imports(
    source: &str,
    imports: &[DeclSpan],
) -> Result<Option<PendingChunk>, ChunkError> {
    if imports.is_empty() {
        return Ok(None);
    }
    let mut sorted = imports.to_vec();
    sorted.sort_by_key(|d| d.start_byte);
    let Some(first) = sorted.first() else {
        return Ok(None);
    };
    let start_byte = first.start_byte;
    let end_byte = sorted.last().map_or(start_byte, |d| d.end_byte);
    let content = sorted
        .iter()
        .map(|d| byte_slice(source, d.start_byte, d.end_byte).trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    let (start_line, end_line) = byte_range_to_lines(source, start_byte, end_byte);
    let token_count = tokenise::count_tokens(&content)?;
    Ok(Some(PendingChunk {
        start_byte,
        end_byte,
        start_line,
        end_line,
        symbol: None,
        kind: ChunkKind::Imports,
        content,
        token_count,
        parent_key: None,
    }))
}

fn declaration_to_pending(
    source: &str,
    decl: &DeclSpan,
    options: &ChunkOptions,
) -> Result<Vec<PendingChunk>, ChunkError> {
    let content = byte_slice(source, decl.start_byte, decl.end_byte).to_owned();
    let token_count = tokenise::count_tokens(&content)?;
    if (token_count as usize) <= options.max_tokens {
        let (start_line, end_line) = byte_range_to_lines(source, decl.start_byte, decl.end_byte);
        return Ok(vec![PendingChunk {
            start_byte: decl.start_byte,
            end_byte: decl.end_byte,
            start_line,
            end_line,
            symbol: decl.symbol.clone(),
            kind: decl.kind,
            content,
            token_count,
            parent_key: decl.parent_key,
        }]);
    }
    split_oversized_declaration(source, decl, options)
}

fn split_oversized_declaration(
    source: &str,
    decl: &DeclSpan,
    options: &ChunkOptions,
) -> Result<Vec<PendingChunk>, ChunkError> {
    let full = byte_slice(source, decl.start_byte, decl.end_byte);
    let lines: Vec<&str> = full.split_inclusive('\n').collect();
    if lines.is_empty() {
        return Ok(Vec::new());
    }

    let overlap = options.split_overlap_lines.min(lines.len()).max(1);
    let header: String = lines.iter().take(overlap).copied().collect();
    let mut out = Vec::new();
    let mut index = 0usize;
    let mut first = true;

    while index < lines.len() {
        let body_start = if first { 0 } else { index };
        let mut end = body_start;
        let mut best_content = String::new();
        let mut best_end = body_start;

        while end < lines.len() {
            let content = if first {
                lines
                    .get(..=end)
                    .map_or_else(String::new, |slice| slice.join(""))
            } else {
                let mut s = header.clone();
                if let Some(slice) = lines.get(body_start..=end) {
                    s.push_str(&slice.join(""));
                }
                s
            };
            if tokenise::count_tokens(&content)? as usize > options.max_tokens {
                break;
            }
            best_content = content;
            best_end = end + 1;
            end += 1;
        }

        if best_end == body_start {
            // A single line exceeds the budget: emit a truncated line window.
            let abs = decl.start_byte
                + lines
                    .iter()
                    .take(body_start)
                    .map(|l| l.len())
                    .sum::<usize>();
            let Some(line) = lines.get(body_start).copied() else {
                break;
            };
            out.extend(slice_to_line_windows(source, line, abs, options)?);
            index = body_start + 1;
            first = false;
            continue;
        }

        let abs_start = if first {
            decl.start_byte
        } else {
            decl.start_byte
                + lines
                    .iter()
                    .take(body_start)
                    .map(|l| l.len())
                    .sum::<usize>()
        };
        let abs_end = decl.start_byte + lines.iter().take(best_end).map(|l| l.len()).sum::<usize>();
        let (start_line, end_line) =
            byte_range_to_lines(source, abs_start, abs_end.max(abs_start.saturating_add(1)));
        let token_count = tokenise::count_tokens(&best_content)?;
        out.push(PendingChunk {
            start_byte: abs_start,
            end_byte: abs_end,
            start_line,
            end_line,
            symbol: decl.symbol.clone(),
            kind: decl.kind,
            content: best_content,
            token_count,
            parent_key: decl.parent_key,
        });
        index = best_end;
        first = false;
    }
    Ok(out)
}

fn merge_small(
    mut pending: Vec<PendingChunk>,
    options: &ChunkOptions,
) -> Result<Vec<PendingChunk>, ChunkError> {
    if pending.is_empty() {
        return Ok(pending);
    }
    pending.sort_by_key(|p| (p.start_byte, p.end_byte));
    let mut out: Vec<PendingChunk> = Vec::with_capacity(pending.len());
    let mut i = 0;
    while i < pending.len() {
        let Some(start) = pending.get(i).cloned() else {
            break;
        };
        let mut current = start;
        while (current.token_count as usize) < options.min_tokens {
            let Some(next) = pending.get(i + 1) else {
                break;
            };
            if !can_merge(&current, next) {
                break;
            }
            let combined = format!("{}\n{}", current.content.trim_end(), next.content);
            let tokens = tokenise::count_tokens(&combined)?;
            if tokens as usize > options.max_tokens {
                break;
            }
            current.end_byte = next.end_byte;
            current.end_line = next.end_line;
            current.content = combined;
            current.token_count = tokens;
            if current.symbol.is_none() {
                current.symbol.clone_from(&next.symbol);
            }
            i += 1;
        }
        out.push(current);
        i += 1;
    }
    Ok(out)
}

fn can_merge(a: &PendingChunk, b: &PendingChunk) -> bool {
    if matches!(a.kind, ChunkKind::Imports | ChunkKind::LineWindow)
        || matches!(b.kind, ChunkKind::Imports | ChunkKind::LineWindow)
    {
        return false;
    }
    if a.kind == ChunkKind::Method && b.kind.is_type_level() {
        return false;
    }
    if a.kind.is_type_level() && b.kind == ChunkKind::Method {
        return false;
    }
    if a.kind.is_type_level() && b.kind.is_type_level() {
        return false;
    }
    // Only merge siblings under a shared type-level parent (e.g. two methods of
    // one class). Top-level declarations keep their own retrieval identity.
    matches!((a.parent_key, b.parent_key), (Some(pa), Some(pb)) if pa == pb)
}

fn enforce_token_ceiling(
    chunks: Vec<Chunk>,
    options: &ChunkOptions,
) -> Result<Vec<Chunk>, ChunkError> {
    let mut out = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        if (chunk.token_count as usize) <= options.max_tokens {
            debug_assert!(chunk.end_line >= chunk.start_line);
            out.push(chunk);
            continue;
        }
        out.extend(line_windows_from_content(
            &chunk.content,
            chunk.start_line,
            chunk.kind,
            chunk.symbol.as_ref(),
            options,
        )?);
    }
    Ok(out)
}

fn line_windows(source: &str, options: &ChunkOptions) -> Result<Vec<Chunk>, ChunkError> {
    line_windows_from_content(source, 1, ChunkKind::LineWindow, None, options)
}

fn slice_to_line_windows(
    source: &str,
    slice: &str,
    abs_start: usize,
    options: &ChunkOptions,
) -> Result<Vec<PendingChunk>, ChunkError> {
    let start_line = line_number(source, abs_start);
    let chunks =
        line_windows_from_content(slice, start_line, ChunkKind::LineWindow, None, options)?;
    Ok(chunks
        .into_iter()
        .map(|c| PendingChunk {
            start_byte: abs_start,
            end_byte: abs_start + slice.len(),
            start_line: c.start_line,
            end_line: c.end_line,
            symbol: None,
            kind: ChunkKind::LineWindow,
            content: c.content,
            token_count: c.token_count,
            parent_key: None,
        })
        .collect())
}

fn line_windows_from_content(
    source: &str,
    first_line: u32,
    kind: ChunkKind,
    symbol: Option<&String>,
    options: &ChunkOptions,
) -> Result<Vec<Chunk>, ChunkError> {
    if source.is_empty() {
        return Ok(Vec::new());
    }
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    let mut out = Vec::new();
    let mut index = 0usize;
    let mut line_no = first_line;
    while index < lines.len() {
        let mut end = index;
        let mut best = String::new();
        let mut best_end = index;
        while end < lines.len() {
            let candidate = lines
                .get(index..=end)
                .map_or_else(String::new, |slice| slice.join(""));
            if tokenise::count_tokens(&candidate)? as usize > options.max_tokens {
                break;
            }
            best = candidate;
            best_end = end + 1;
            end += 1;
        }
        if best_end == index {
            let Some(line) = lines.get(index).copied() else {
                break;
            };
            let truncated = truncate_to_max_tokens(line, options.max_tokens)?;
            let token_count = tokenise::count_tokens(&truncated)?;
            out.push(Chunk {
                start_line: line_no,
                end_line: line_no,
                symbol: symbol.cloned(),
                kind,
                content: truncated,
                token_count,
            });
            line_no = line_no.saturating_add(1);
            index += 1;
            continue;
        }
        let line_count = u32::try_from(best_end - index).unwrap_or(u32::MAX);
        let end_line = line_no.saturating_add(line_count.saturating_sub(1));
        let token_count = tokenise::count_tokens(&best)?;
        out.push(Chunk {
            start_line: line_no,
            end_line,
            symbol: symbol.cloned(),
            kind,
            content: best,
            token_count,
        });
        line_no = end_line.saturating_add(1);
        index = best_end;
    }
    Ok(out)
}

fn truncate_to_max_tokens(text: &str, max_tokens: usize) -> Result<String, ChunkError> {
    if tokenise::count_tokens(text)? as usize <= max_tokens {
        return Ok(text.to_owned());
    }
    let mut lo = 0usize;
    let mut hi = text.len();
    let mut best = String::new();
    while lo <= hi {
        let mid = usize::midpoint(lo, hi);
        let end = floor_char_boundary(text, mid);
        let candidate = text.get(..end).unwrap_or("");
        if tokenise::count_tokens(candidate)? as usize <= max_tokens {
            candidate.clone_into(&mut best);
            lo = end.saturating_add(1);
        } else if end == 0 {
            break;
        } else {
            hi = end.saturating_sub(1);
        }
    }
    Ok(best)
}

fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn error_ranges(root: Node<'_>) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.is_error() || node.kind() == "ERROR" {
            out.push((node.start_byte(), node.end_byte()));
            continue;
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            stack.push(child);
        }
    }
    out
}

fn covered_ranges(pending: &[PendingChunk]) -> Vec<(usize, usize)> {
    pending.iter().map(|p| (p.start_byte, p.end_byte)).collect()
}

fn range_overlaps_any(start: usize, end: usize, covered: &[(usize, usize)]) -> bool {
    covered.iter().any(|&(c0, c1)| start < c1 && end > c0)
}

fn byte_slice(source: &str, start: usize, end: usize) -> &str {
    let start = floor_char_boundary(source, start.min(source.len()));
    let mut end = floor_char_boundary(source, end.min(source.len()));
    if end < start {
        end = start;
    }
    source.get(start..end).unwrap_or("")
}

fn byte_range_to_lines(source: &str, start_byte: usize, end_byte: usize) -> (u32, u32) {
    let start_byte = start_byte.min(source.len());
    let end_byte = end_byte.min(source.len()).max(start_byte);
    let start_line = line_number(source, start_byte);
    let last = if end_byte > start_byte {
        end_byte - 1
    } else {
        start_byte
    };
    let end_line = line_number(source, last);
    (start_line, end_line.max(start_line))
}

fn line_number(source: &str, byte: usize) -> u32 {
    u32::try_from(byte_to_line(source, byte))
        .unwrap_or(u32::MAX)
        .saturating_add(1)
}

#[allow(clippy::naive_bytecount)] // avoid a dep for a single hot-path count
fn byte_to_line(source: &str, byte: usize) -> usize {
    let byte = byte.min(source.len());
    source
        .as_bytes()
        .get(..byte)
        .map_or(0, |bytes| bytes.iter().filter(|&&b| b == b'\n').count())
}
