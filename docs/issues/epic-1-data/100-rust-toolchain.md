---
title: '[ci] Rust toolchain for crates/ic-engine with cargo and maturin'
labels: tier:2, size:s, area:ci, epic:1-data
---

### Epic

#2

### Context

The ingestion engine is Rust because it is the part of the system where memory and speed actually
decide whether the product works. Parsing and embedding a large repository in a Node or Python
process means either a slow single thread or a heap that makes the stated goal of running well on an
ordinary laptop impossible.

The engine has to be callable two ways. A CLI is what CI and benchmarks invoke, and it is what makes
the engine testable without any of the rest of the stack. A PyO3 module is what the Python brain
calls, in-process, so that ingesting a repository does not serialise several hundred megabytes of
chunks across a subprocess boundary.

This issue establishes the crate, both build targets, and the CI wiring. Parsing, chunking, and
embedding are separate issues in the engine epic.

Spec: `docs/DELIVERY.md`

### Contract

```rust
// crates/ic-engine/src/lib.rs
pub struct EngineConfig {
    pub max_file_bytes: usize,
    pub concurrency: usize,
}

pub fn version() -> &'static str;

// Exposed to Python as `ic_engine`.
#[pyfunction]
fn version() -> PyResult<String>;
```

```
crates/ic-engine/
  Cargo.toml        # crate-type = ["cdylib", "rlib"]
  src/lib.rs        # library, including the PyO3 module behind a `python` feature
  src/main.rs       # the `ic-engine` CLI
  benches/          # criterion harness, empty but wired
```

The CLI must support `ic-engine --version` and `ic-engine --help` and exit 0 for both, since Gate 6
uses the binary as its benchmark entry point.

### Files

- CREATE `Cargo.toml` (workspace root)
- CREATE `crates/ic-engine/Cargo.toml`
- CREATE `crates/ic-engine/src/lib.rs`
- CREATE `crates/ic-engine/src/main.rs`
- CREATE `crates/ic-engine/benches/ingest.rs`
- CREATE `crates/ic-engine/README.md`
- CREATE `rust-toolchain.toml`
- MODIFY `.github/workflows/gate-static.yml` - remove the "not present yet" notice path
- MODIFY `.github/workflows/gate-test.yml` - remove the "not present yet" notice path
- MODIFY `.gitignore` - ignore `target/`

### Acceptance Criteria

- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy -- -D warnings` passes with no allow attributes
- [ ] `cargo test` passes
- [ ] `cargo build --release` produces an `ic-engine` binary that prints its version and exits 0
- [ ] `maturin build` produces an importable wheel and `import ic_engine` succeeds
- [ ] `ic_engine.version()` from Python returns the same string as the CLI
- [ ] The toolchain is pinned in `rust-toolchain.toml` so CI and local builds match
- [ ] Gate 2 and Gate 3 run the Rust steps for real rather than logging a notice

### Required Tests

- `version_is_not_empty` - Rust unit test
- `cli_version_exits_zero` - Rust integration test invoking the binary

### Performance Budget

`cargo build --release` completes in under 3 minutes on the CI runner from a cold cache. The release
binary is under 20MB.

### Out of Scope

- Do not add tree-sitter, embedding, or database code; those are the engine epic
- Do not publish the crate or the wheel to any registry
- Do not add a second crate; the workspace has one member until there is a reason for more
- Do not wire the wheel into the brain's test environment. `services/brain` does not exist on `main`
  yet, and building plus installing the wheel is a CI change that belongs with the Python package.
  Version parity is tracked separately in #38.

### Dependencies

none

### Verification

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release && ./target/release/ic-engine --version
maturin build -m crates/ic-engine/Cargo.toml --features python
python -c "import ic_engine; print(ic_engine.version())"
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
