# ic-engine

Repository ingestion: parsing, chunking, and embedding.

This is Rust because it is the part of the system where memory and speed decide whether the product
works. Parsing and embedding a large repository from Node or Python means either one slow thread or
a heap that rules out the ordinary laptop this is meant to run on.

Right now the crate carries the skeleton (version, config, CLI, Python bridge), the repository
walker (ignore rules, SHA-256 content hashing, Merkle manifest), tree-sitter parsing plus
AST-boundary chunking, and a local int8 embedder for 384-dimension vectors.

## Two entry points

The **`ic-engine` binary** is what benchmarks and CI drive. It keeps the engine measurable without
standing up the API, the database, or Python.

```bash
cargo run --bin ic-engine -- --version
```

The **`ic_engine` Python module** is what the brain service calls, in-process, so that ingesting a
repository does not serialise several hundred megabytes of chunks across a subprocess boundary.

```bash
maturin build -m crates/ic-engine/Cargo.toml --release
python -c "import ic_engine; print(ic_engine.version())"
```

Both report the same version string, so a bug reported against one describes the same build as the
other.

## Repository walk and Merkle manifest

`walk` answers which files are worth reading and which of them changed. It returns a `RepoManifest`
with every hashed text file, every skipped path and reason, and a `root_hash` over the tree.

### Ignore rules and the built-in deny list

The walker uses `ignore::WalkBuilder` with `follow_links(false)` and `require_git(false)`, so a
tarball checkout without a `.git` directory still honours `.gitignore` and `.ignore`. Symlinks are
never followed; escaping links are recorded as `SkipReason::OutsideRoot` and their targets are not
read.

On top of ignore files, a built-in deny list drops content that is useless to index even when a
repository forgets to exclude it:

`.git/`, `node_modules/`, `target/`, `dist/`, `build/`, `.next/`, `vendor/`, `__pycache__/`,
`.venv/`, `*.min.js`, `*.min.css`, `*.map`, `*.lock`, `pnpm-lock.yaml`, `package-lock.json`,
`poetry.lock`, `Cargo.lock`, `uv.lock`.

Ignored **files** appear in `skipped` with `SkipReason::Ignored` so a `.gitignore` change is visible
in the manifest. Ignored **directories** are pruned and contribute nothing to the Merkle tree, so
adding a vendored tree does not invalidate an unchanged root hash.

Files over `max_file_bytes` are skipped without reading; a NUL in the first 8 KiB is `Binary`.

### Merkle construction

Hashing uses SHA-256 (matching `files.sha256`). The tree is defined exactly so two implementations
cannot disagree:

```text
file entry     = sha256(contents)
skipped entry  = sha256("skip\0" || reason_discriminant)
directory hash = sha256( for each child, sorted by name as bytes:
                           name || "\0" || kind || "\0" || child_hash || "\n" )
                 where kind is "f", "s", or "d"
root_hash      = directory hash of the root directory
```

Skipped entries participate so a size-cap crossing or an ignore change moves `root_hash`. Empty
directories after filtering contribute nothing. `RepoManifest::diff` classifies every hashed path as
exactly one of added, modified, removed, or unchanged.

## Parsing and chunking

`chunk_file` / `chunk_manifest` split source on declaration boundaries so a retrieved chunk is a
thing a developer would recognise. Token counts come from the committed
`assets/bge-small-en-v1.5/tokenizer.json` (no model weights), the same tokeniser the embedder
uses when truncating long inputs.

### Supported languages

| Language   | Extensions                             | Query file               |
| ---------- | -------------------------------------- | ------------------------ |
| TypeScript | `.ts`, `.d.ts`                         | `queries/typescript.scm` |
| TSX        | `.tsx`                                 | `queries/tsx.scm`        |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx`          | `queries/javascript.scm` |
| Python     | `.py`, `.pyi`, `#!/usr/bin/env python` | `queries/python.scm`     |
| Rust       | `.rs`                                  | `queries/rust.scm`       |
| Go         | `.go`                                  | `queries/go.scm`         |

Everything else falls back to `line_window` chunks rather than being dropped.

### Chunking rules

1. Split at the smallest `@declaration` capture (function, method, class, struct, interface, type
   alias). Leading doc comments, attributes, and decorators attach to the declaration that follows.
2. Imports and top-level `use` statements collapse into one `imports` chunk.
3. A declaration above `max_tokens` (default 512) splits with `split_overlap_lines` of the signature
   repeated on each continuation; split pieces keep the parent `symbol`.
4. Consecutive declarations below `min_tokens` (default 64) merge when they share a parent; a method
   never merges with the following class.
5. Files with no grammar, parse timeouts, and tree-sitter `ERROR` ranges become `line_window`
   chunks. Timeouts are counted in `ChunkStats::files_timed_out` and do not fail the run.

`chunk_manifest` parses one file per worker and pushes results through a bounded channel so a slow
Postgres sink applies backpressure instead of accumulating the whole repository in RAM.

### Adding a grammar

1. Add the `tree-sitter-*` crate to `Cargo.toml`.
2. Extend `Language` in `src/parse.rs` (extension, shebang, `name`, `grammar`, `query_source`).
3. Add `queries/<language>.scm` with `@declaration` / `@name` / `@import` captures.
4. Map new node kinds in `kind_from_node` only when the defaults do not already classify them.

## Local embeddings

`LocalEmbedder` runs the int8-quantised ONNX form of `bge-small-en-v1.5` through `fastembed` on
ONNX Runtime's CPU execution provider. The dimension is fixed at 384 to match
`chunk_embeddings.embedding halfvec(384)`. Vectors are L2-normalised before they leave the
embedder so a unit-length vector loses less precision when stored as `halfvec`, and so dot
product and cosine distance agree if a later query uses the cheaper operator.

### Model cache and offline mode

Weights are not in the repository. The first `LocalEmbedder::load` fetches
`Qdrant/bge-small-en-v1.5-onnx-Q` into:

- `$XDG_CACHE_HOME/infracanvas/models`, or
- `~/.cache/infracanvas/models` when `XDG_CACHE_HOME` is unset

Override the location with `LocalEmbedderOptions::cache_dir`. The same directory is shared by the
CLI, the Python wheel, and CI.

`LocalEmbedder::load` with `offline: true` and an empty cache returns `EmbedError::ModelNotCached`
naming that directory, without opening a network socket. After the first successful fetch, a second
load with `offline: true` succeeds from disk alone. `LocalEmbedder::is_cached` lets a caller warn
before a download.

`model_id()` returns `bge-small-en-v1.5-q` for the `chunk_embeddings.model` column. Inputs longer
than `max_tokens()` (512) are truncated at a token boundary with the committed tokeniser rather than
rejected. One `LocalEmbedder` instance is `Send + Sync` and serves every worker; the ONNX session is
shared.

## Why `extension-module` is not in Cargo.toml

That pyo3 feature stops the crate linking libpython, which is correct for a wheel and fatal for
`cargo test`, since the test binary then has no interpreter to resolve its symbols against. CI runs
`cargo test --all-features`, so the feature is applied by maturin at build time through
`[tool.maturin] features` in `pyproject.toml` instead.

## Checks

The same commands the gates run:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features --workspace
cargo build --release
```

## Lints

`clippy::pedantic` is a workspace warning and is denied in CI: locally a lint should tell you
something without stopping you mid-thought, and in CI it should block.

The panic-avoidance lints (`unwrap_used`, `expect_used`, `indexing_slicing`, `panic`) are declared at
each crate root rather than across the workspace. The engine parses untrusted repository content,
where a panic is a denial of service rather than a crash report. A workspace-wide setting would also
reach integration tests, where a panic _is_ the assertion mechanism, and allowing it back in every
test file would suppress the lint exactly where it matters.

## Toolchain

`rust-toolchain.toml` pins the compiler. Tracking `stable` means a compiler release can turn a green
pull request red overnight and a new upstream lint arrives as a surprise rather than a deliberate
bump.

## Benchmarks

`benches/ingest.rs` includes a `walk` criterion bench over a generated tree, a `chunk` bench over
`tests/data/sample.ts`, and an `embed` bench for 128-token inputs at `batch_size: 64`. Gate 6
compares runs against a stored baseline; the large perf fixture is owned by the index issue.
