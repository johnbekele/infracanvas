//! Integration tests for AST-boundary chunking.

use std::fs;
use std::path::PathBuf;

use ic_engine::{
    Chunk, ChunkKind, ChunkOptions, FileRecord, Language, RepoManifest, chunk_file, chunk_manifest,
};
use tempfile::TempDir;

fn data(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data")
        .join(name);
    fs::read_to_string(path).expect("fixture")
}

/// Body of `tests/data/broken.ts` — kept as a string-array there so Gate 2 can
/// parse the fixture file, and mirrored here as the source the chunker sees.
fn broken_typescript_source() -> &'static str {
    concat!(
        "export function beforeError(): number {\n",
        "  return 1;\n",
        "}\n",
        "\n",
        "export function broken({{{\n",
        "\n",
        "export function afterError(): number {\n",
        "  return 2;\n",
        "}"
    )
}

fn symbols(chunks: &[Chunk]) -> Vec<Option<&str>> {
    chunks.iter().map(|c| c.symbol.as_deref()).collect()
}

#[test]
fn splits_a_typescript_file_at_function_boundaries() {
    let source = data("sample.ts");
    let chunks = chunk_file(
        &source,
        Some(Language::TypeScript),
        &ChunkOptions::default(),
    )
    .expect("chunk");
    let functions: Vec<_> = chunks
        .iter()
        .filter(|c| c.kind == ChunkKind::Function)
        .collect();
    assert_eq!(functions.len(), 3);
    assert_eq!(
        symbols(&functions.iter().map(|c| (*c).clone()).collect::<Vec<_>>()),
        vec![Some("alpha"), Some("beta"), Some("gamma")]
    );
    for chunk in &chunks {
        assert!(chunk.end_line >= chunk.start_line);
        assert!(chunk.start_line >= 1);
    }
}

#[test]
fn keeps_a_python_docstring_with_its_function() {
    let source = data("sample.py");
    let chunks =
        chunk_file(&source, Some(Language::Python), &ChunkOptions::default()).expect("chunk");
    let greet = chunks
        .iter()
        .find(|c| c.symbol.as_deref() == Some("greet"))
        .expect("greet chunk");
    assert!(greet.content.contains("def greet"));
    assert!(greet.content.contains("Return a friendly greeting"));
}

#[test]
fn collapses_imports_into_one_chunk() {
    let source = data("sample.ts");
    let chunks = chunk_file(
        &source,
        Some(Language::TypeScript),
        &ChunkOptions::default(),
    )
    .expect("chunk");
    let imports: Vec<_> = chunks
        .iter()
        .filter(|c| c.kind == ChunkKind::Imports)
        .collect();
    assert_eq!(imports.len(), 1);
    assert!(imports[0].symbol.is_none());
    assert!(
        imports[0]
            .content
            .contains("import { readFile as _readFile }")
    );
    assert!(imports[0].content.contains("import _path from"));
    assert!(
        imports[0]
            .content
            .contains("import { createHash as _createHash }")
    );
}

#[test]
fn splits_a_declaration_larger_than_the_token_budget_and_repeats_the_signature() {
    use std::fmt::Write;

    let mut body = String::from("export function huge(): number {\n");
    for i in 0..200 {
        let _ = writeln!(body, "  const x{i} = {i};");
    }
    body.push_str("  return 0;\n}\n");

    let options = ChunkOptions {
        max_tokens: 40,
        min_tokens: 1,
        split_overlap_lines: 2,
        parse_timeout_ms: 5_000,
    };
    let chunks = chunk_file(&body, Some(Language::TypeScript), &options).expect("chunk");
    let parts: Vec<_> = chunks
        .iter()
        .filter(|c| c.symbol.as_deref() == Some("huge"))
        .collect();
    assert!(parts.len() >= 2, "expected a split, got {}", parts.len());
    for part in &parts {
        assert_eq!(part.symbol.as_deref(), Some("huge"));
        assert!(
            part.content.contains("export function huge") || part.content.contains("function huge"),
            "overlap missing in {:?}",
            &part.content[..part.content.len().min(80)]
        );
        assert!((part.token_count as usize) <= options.max_tokens);
    }
}

#[test]
fn merges_small_adjacent_methods_without_crossing_a_class_boundary() {
    let source = r"
export class Alpha {
  a(): number { return 1; }
  b(): number { return 2; }
}

export class Beta {
  c(): number { return 3; }
}
";
    let options = ChunkOptions {
        max_tokens: 512,
        min_tokens: 64,
        split_overlap_lines: 2,
        parse_timeout_ms: 5_000,
    };
    let chunks = chunk_file(source, Some(Language::TypeScript), &options).expect("chunk");

    // With a high min_tokens, the two tiny methods of Alpha should merge into one
    // chunk, and that merge must not swallow Beta.
    let alpha_merged = chunks.iter().any(|c| {
        c.content.contains("a(): number")
            && c.content.contains("b(): number")
            && !c.content.contains("class Beta")
    });
    assert!(alpha_merged, "expected Alpha methods to merge: {chunks:#?}");

    let crossed = chunks.iter().any(|c| {
        (c.content.contains("a(): number") || c.content.contains("b(): number"))
            && c.content.contains("class Beta")
    });
    assert!(!crossed, "method merged across class boundary: {chunks:#?}");
}

#[test]
fn never_emits_a_chunk_over_the_token_budget() {
    let options = ChunkOptions {
        max_tokens: 32,
        min_tokens: 1,
        split_overlap_lines: 2,
        parse_timeout_ms: 5_000,
    };
    for name in ["sample.ts", "sample.py"] {
        let source = data(name);
        let language = Language::from_path(name);
        let chunks = chunk_file(&source, language, &options).expect("chunk");
        for chunk in chunks {
            assert!(
                (chunk.token_count as usize) <= options.max_tokens,
                "{}: {} > {} for {:?}",
                name,
                chunk.token_count,
                options.max_tokens,
                chunk.symbol
            );
            assert!(chunk.end_line >= chunk.start_line);
        }
    }
    let chunks = chunk_file(
        broken_typescript_source(),
        Some(Language::TypeScript),
        &options,
    )
    .expect("chunk");
    for chunk in &chunks {
        assert!((chunk.token_count as usize) <= options.max_tokens);
        assert!(chunk.end_line >= chunk.start_line);
    }
}

#[test]
fn chunks_the_parseable_part_of_a_file_with_a_syntax_error() {
    let source = broken_typescript_source();
    let chunks =
        chunk_file(source, Some(Language::TypeScript), &ChunkOptions::default()).expect("chunk");
    let symbols: Vec<_> = chunks.iter().filter_map(|c| c.symbol.as_deref()).collect();
    assert!(
        symbols.contains(&"beforeError"),
        "missing beforeError in {symbols:?}"
    );
    // afterError may parse depending on recovery; ERROR ranges become line windows.
    assert!(
        chunks.iter().any(|c| c.kind == ChunkKind::LineWindow) || symbols.contains(&"afterError"),
        "expected recovery artifacts: {chunks:#?}"
    );
}

#[test]
fn falls_back_to_line_windows_for_a_file_with_no_grammar() {
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("note.rb");
    fs::write(&path, "puts 'hello'\nputs 'world'\n").expect("write");

    let file = FileRecord {
        path: "note.rb".to_owned(),
        size_bytes: 24,
        sha256: "00".repeat(32),
    };
    let manifest = RepoManifest {
        root: dir.path().to_path_buf(),
        root_hash: "00".repeat(32),
        files: vec![file],
        skipped: vec![],
        bytes_read: 24,
    };

    let mut saw = Vec::new();
    let stats = chunk_manifest(
        &manifest,
        &ChunkOptions::default(),
        2,
        &mut |record, chunks| {
            saw.push((record.path.clone(), chunks));
            Ok(())
        },
    )
    .expect("manifest");

    assert_eq!(stats.files_line_windowed, 1);
    assert_eq!(stats.files_parsed, 0);
    assert_eq!(saw.len(), 1);
    assert!(saw[0].1.iter().all(|c| c.kind == ChunkKind::LineWindow));
}

#[test]
fn abandons_a_file_that_exceeds_the_parse_timeout_without_failing_the_run() {
    let dir = TempDir::new().expect("tempdir");
    // Highly nested braces force the parser to do real work so a 1µs budget expires.
    let mut source = String::from("export function deep(): number {\n");
    for _ in 0..4_000 {
        source.push_str("  {");
    }
    source.push_str(" return 1; ");
    for _ in 0..4_000 {
        source.push('}');
    }
    source.push_str("\n}\n");

    let path = dir.path().join("deep.ts");
    fs::write(&path, &source).expect("write");

    let file = FileRecord {
        path: "deep.ts".to_owned(),
        size_bytes: source.len() as u64,
        sha256: "11".repeat(32),
    };
    let manifest = RepoManifest {
        root: dir.path().to_path_buf(),
        root_hash: "11".repeat(32),
        files: vec![file],
        skipped: vec![],
        bytes_read: source.len() as u64,
    };

    let options = ChunkOptions {
        max_tokens: 512,
        min_tokens: 64,
        split_overlap_lines: 2,
        parse_timeout_ms: 0,
    };

    let stats = chunk_manifest(&manifest, &options, 1, &mut |_record, chunks| {
        assert!(chunks.iter().all(|c| c.kind == ChunkKind::LineWindow));
        Ok(())
    })
    .expect("timeout must not fail the run");

    assert!(
        stats.files_timed_out >= 1,
        "expected a timeout count, got {stats:?}"
    );
}
