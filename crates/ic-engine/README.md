# ic-engine

Repository ingestion: parsing, chunking, and embedding.

This is Rust because it is the part of the system where memory and speed decide whether the product
works. Parsing and embedding a large repository from Node or Python means either one slow thread or
a heap that rules out the ordinary laptop this is meant to run on.

Right now it is a skeleton: a version function, a config type, a CLI, and the Python bridge. That is
enough to establish both build targets and turn on the Rust halves of Gates 2, 3, and 5. Tree-sitter
parsing, chunking, and embedding land in the engine epic.

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

`benches/ingest.rs` is wired but nearly empty. Gate 6 compares each run against a stored baseline,
and a harness that appears only alongside the code it measures has no baseline on the day it is
needed.
