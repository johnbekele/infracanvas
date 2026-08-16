# ic-engine

Repository ingestion: parsing, chunking, and embedding.

This is Rust because it is the part of the system where memory and speed decide whether the product
works. Parsing and embedding a large repository from Node or Python means either one slow thread or
a heap that rules out the ordinary laptop this is meant to run on.

Right now the crate carries the skeleton (version, config, CLI, Python bridge) and the repository
walker: ignore rules, SHA-256 content hashing, and a Merkle manifest. Tree-sitter parsing, chunking,
and embedding land later in the engine epic.

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

`benches/ingest.rs` includes a `walk` criterion bench over a generated tree. Gate 6 compares runs
against a stored baseline; the large perf fixture is owned by the index issue.
