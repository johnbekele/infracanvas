---
title: '[rust] Tree-sitter parsing and chunking on AST boundaries'
labels: tier:2, size:l, area:rust, epic:3-engine
---

### Epic

#4

### Context

Retrieval quality is decided here. A fixed 40-line window cuts a function in half, so the half
containing the signature has no body and the half containing the body has no name; both embed badly
and neither is useful on its own when it is retrieved. Chunking on declaration boundaries means a
retrieved chunk is a thing a developer would recognise, and the `symbol` and `kind` columns in #25 can
be populated with something real instead of being left null.

The parser is tree-sitter rather than a per-language library or a regex pass. It is error-tolerant,
which matters because a repository at an arbitrary commit contains files that do not compile, and a
chunker that gives up on a syntax error would silently lose whole directories during a refactor. It
also gives the same tree shape API for every grammar, so adding a language is a grammar dependency and
a query file rather than a new code path. The rejected alternative was language-specific parsers
(`syn` for Rust, `swc` for TypeScript, `rustpython-parser` for Python), which produce better trees and
would mean five unrelated failure modes, five error-recovery stories, and roughly five times the code.

The starting set of languages is TypeScript, TSX, JavaScript, Python, Rust, and Go. That is chosen to
match what the product must profile to be useful at all: the repositories users will connect are
overwhelmingly web applications and services in those languages, and the existing
`packages/core/src/analysis/profile.ts` already reasons about their ecosystems. Everything else falls
back to line windows and is recorded as such, rather than being dropped, so a Ruby service still turns
up in search results with worse chunk boundaries instead of not turning up at all.

Token counts come from the real tokeniser, not from a character estimate. The `token_count` column in
#25 is only meaningful if it is the number the embedder will see, and a `len / 4` estimate is wrong
often enough that chunks quietly exceed the model's 512-token window and get truncated mid-function,
which is exactly the failure the AST boundaries were introduced to avoid. The tokeniser for
`bge-small-en-v1.5` is a 700KB `tokenizer.json` with no model weights, so it is committed under
`crates/ic-engine/assets/` and loaded by both this stage and the embedder in
`docs/issues/epic-3-engine/030-local-embeddings.md`.

Chunks are streamed to the caller through a channel rather than accumulated into a `Vec<Chunk>` for
the whole repository. Holding every chunk of a large repository in memory is roughly the entire RSS
budget on its own, and the consumer writes them to Postgres in batches anyway.

Spec: `crates/ic-engine/README.md`

### Contract

```rust
// crates/ic-engine/src/parse.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Rust,
    Go,
}

impl Language {
    /// By extension, then by shebang for extensionless files. `None` means no grammar.
    pub fn from_path(path: &str) -> Option<Self>;
    pub fn from_shebang(first_line: &str) -> Option<Self>;
    /// Stable lowercase name written to `files.language`, for example `typescript`.
    pub fn name(self) -> &'static str;
    pub fn grammar(self) -> tree_sitter::Language;
}
```

```rust
// crates/ic-engine/src/chunk.rs
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
    pub fn as_str(self) -> &'static str;
}

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

#[derive(Debug, thiserror::Error)]
pub enum ChunkError {
    #[error("no grammar for {0}")]
    UnsupportedLanguage(String),
    #[error("parsing {path} exceeded {timeout_ms}ms")]
    ParseTimeout { path: String, timeout_ms: u64 },
    #[error("tokeniser unavailable: {0}")]
    Tokeniser(String),
}

/// Chunks one file. Never panics on malformed input; a file that cannot be parsed at all
/// yields line windows rather than an error.
pub fn chunk_file(
    source: &str,
    language: Option<Language>,
    options: &ChunkOptions,
) -> Result<Vec<Chunk>, ChunkError>;

/// Streams chunks for a whole manifest, one file at a time, bounded by `concurrency`.
/// The channel is bounded so a slow consumer applies backpressure instead of growing the heap.
pub fn chunk_manifest(
    manifest: &RepoManifest,
    options: &ChunkOptions,
    concurrency: usize,
    sink: &mut dyn FnMut(&FileRecord, Vec<Chunk>) -> Result<(), ChunkError>,
) -> Result<ChunkStats, ChunkError>;

pub struct ChunkStats {
    pub files_parsed: usize,
    pub files_line_windowed: usize,
    pub files_timed_out: usize,
    pub chunks_emitted: usize,
}
```

The chunking rules, in the order they are applied:

1. Split at the smallest AST node that declares something: a function, method, class, struct, impl
   block member, interface, or type alias. Node types per language live in
   `crates/ic-engine/queries/<language>.scm` as tree-sitter queries with a `@declaration` capture, so
   adding a language does not touch Rust code.
2. Leading doc comments, attributes, and decorators attach to the declaration that follows them. A
   Python docstring stays with its function, because the docstring holds the words a user will search
   for.
3. Imports and top-level `use` statements collapse into a single `Imports` chunk. A query about which
   library a file uses has to resolve to something.
4. A declaration above `max_tokens` splits at its child statement boundaries, repeating
   `split_overlap_lines` so the signature is present in the continuation. The split chunks keep the
   parent's `symbol`.
5. Consecutive declarations below `min_tokens` merge until they reach it, never crossing a parent
   boundary. Two small methods of one class may merge; a method and the next class may not.
6. A file with no grammar, and the byte ranges of a parsed file that tree-sitter marks as `ERROR`,
   become `LineWindow` chunks of at most `max_tokens`.
7. `token_count` is the tokeniser's count for `content`. No chunk exceeds `max_tokens`, which is
   asserted as a post-condition over every emitted chunk rather than trusted.

Parsing runs with `tree_sitter::Parser::set_timeout_micros` so a pathological file, minified code that
slipped past the deny list being the realistic case, costs one file rather than the run. The file is
counted in `files_timed_out` and line-windowed.

### Files

- CREATE `crates/ic-engine/src/parse.rs`
- CREATE `crates/ic-engine/src/chunk.rs`
- CREATE `crates/ic-engine/src/tokenise.rs` - loads the committed tokeniser, shared with the embedder
- CREATE `crates/ic-engine/queries/typescript.scm`
- CREATE `crates/ic-engine/queries/tsx.scm`
- CREATE `crates/ic-engine/queries/javascript.scm`
- CREATE `crates/ic-engine/queries/python.scm`
- CREATE `crates/ic-engine/queries/rust.scm`
- CREATE `crates/ic-engine/queries/go.scm`
- CREATE `crates/ic-engine/assets/bge-small-en-v1.5/tokenizer.json` - tokeniser only, no weights
- CREATE `crates/ic-engine/tests/chunk.rs`
- CREATE `crates/ic-engine/tests/data/sample.ts`
- CREATE `crates/ic-engine/tests/data/sample.py`
- CREATE `crates/ic-engine/tests/data/broken.ts` - a deliberate syntax error
- MODIFY `crates/ic-engine/src/lib.rs` - declare and re-export the parse, chunk, and tokenise modules
- MODIFY `crates/ic-engine/Cargo.toml` - add `tree-sitter` and the six grammar crates, plus `tokenizers`
- MODIFY `crates/ic-engine/benches/ingest.rs` - add a chunking benchmark over `tests/data/sample.ts`
- MODIFY `crates/ic-engine/README.md` - document the languages, the rules, and how to add a grammar

### Acceptance Criteria

- [ ] A TypeScript file with three exported functions yields three chunks whose `symbol` values are the function names
- [ ] A Python function's docstring appears in the same chunk as its `def` line
- [ ] Imports collapse into one chunk of kind `imports` with no `symbol`
- [ ] A function longer than `max_tokens` splits into chunks that each carry the parent symbol and repeat the overlap lines
- [ ] Two adjacent methods below `min_tokens` merge, and a method never merges with the following class
- [ ] No emitted chunk has `token_count` above `max_tokens`, for any input in the test corpus
- [ ] A file with a syntax error yields chunks for the parts that parsed and line windows for the rest
- [ ] A file with no supported grammar yields `LineWindow` chunks and increments `files_line_windowed`
- [ ] A file that exceeds `parse_timeout_ms` increments `files_timed_out` and does not fail the run
- [ ] `start_line` and `end_line` are one-based and inclusive, and `end_line >= start_line` for every chunk, matching the `CHECK` constraint in #25

### Required Tests

- `splits_a_typescript_file_at_function_boundaries`
- `keeps_a_python_docstring_with_its_function`
- `collapses_imports_into_one_chunk`
- `splits_a_declaration_larger_than_the_token_budget_and_repeats_the_signature`
- `merges_small_adjacent_methods_without_crossing_a_class_boundary`
- `never_emits_a_chunk_over_the_token_budget`
- `chunks_the_parseable_part_of_a_file_with_a_syntax_error`
- `falls_back_to_line_windows_for_a_file_with_no_grammar`
- `abandons_a_file_that_exceeds_the_parse_timeout_without_failing_the_run`

### Performance Budget

Parsing and chunking the roughly 40k source files in the 100k-file perf fixture completes in under 25
seconds with eight threads, measured through the index benchmark. A single 400-line TypeScript file
chunks in under 8ms at p95, measured by the `chunk` criterion benchmark. Peak RSS for this stage stays
under 150MB, which the bounded channel and one-file-per-worker parsing are what guarantee. This stage
is allocated 25 of the epic's 120-second whole-pipeline budget.

### Out of Scope

- Do not extract call graphs, imports as edges, or any other cross-file relationship. That is the
  graph epic (#6) and it reads these chunks rather than replacing them
- Do not embed anything. The `Embedder` trait is
  `docs/issues/epic-3-engine/030-local-embeddings.md`, and this stage only counts tokens
- Do not write to Postgres; the sink is a callback until
  `docs/issues/epic-3-engine/040-index-writes-to-postgres.md`
- Do not add grammars beyond the six named. A seventh is a small follow-up issue once the query files
  prove the pattern
- Do not commit model weights. Only `tokenizer.json` belongs in the repository, and Gate 5 will flag a
  large binary
- Do not change the deny list or anything else in `walk.rs`

### Dependencies

Blocked by the manifest in `docs/issues/epic-3-engine/010-repository-walker-and-merkle-hashing.md`.
The columns these chunks are shaped for are defined in #25.

### Verification

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-features --workspace
cargo bench -- chunk --noplot
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
