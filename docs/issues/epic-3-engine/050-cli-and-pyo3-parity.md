---
title: '[rust] CLI and PyO3 module exposing the same operations from one crate'
labels: tier:2, size:m, area:rust, epic:3-engine
---

### Epic

#4

### Context

The engine has two callers with different needs. CI, benchmarks, and anyone debugging an ingest want a
binary they can run against a directory. The brain wants to index a repository from inside a FastAPI
request without serialising several hundred megabytes of chunks across a subprocess boundary. Both
must be the same engine: two entry points that drift are how a bug reproduces through one path and not
the other, and #31 already established version parity for exactly that reason.

Parity is structural rather than tested into existence. Both entry points are thin argument-translation
layers over `ic_engine::index`, `ic_engine::walk`, and the `Embedder` trait, and neither contains
pipeline logic. The test that matters therefore compares the two on the same fixture and asserts the
same stats, which is cheap precisely because there is nothing between the boundary and the shared
function.

The PyO3 function releases the GIL for the whole run with `Python::allow_threads`. Without it, a single
ingest blocks the brain's event loop for a minute or more and every other request in that worker times
out, which looks like a database problem and is not. This is the one part of the boundary that is easy
to get wrong and invisible until production, so it has its own test that drives an asyncio heartbeat
while indexing and asserts the ticks continue.

The module ships a `.pyi` stub and a `py.typed` marker. `services/brain` runs `mypy --strict`, which
treats an untyped extension module as an error rather than as `Any`, so without the stub the brain
cannot import the engine at all without loosening its own type checking. Writing the stub by hand is
accepted: PyO3 has no stable stub generator, and a hand-written stub for four functions is less risk
than a build-time generator that has to be kept working.

Errors cross the boundary as a small exception hierarchy rather than as strings. A caller in the brain
needs to distinguish "the database is unreachable, retry the job" from "this repository cannot be
parsed, fail the run", and `except RuntimeError` with string matching is not something to build retry
logic on.

Spec: `crates/ic-engine/README.md`

### Contract

The CLI surface, replacing the placeholder command set from #31:

```text
ic-engine index <path> --repository-id <uuid> --run-id <uuid> [--previous-run-id <uuid>]
                       [--database-url <url>] [--no-embeddings] [--concurrency <n>]
                       [--max-file-bytes <n>] [--json]
ic-engine walk <path> [--max-file-bytes <n>] [--json]
ic-engine embed --text <text> [--json]
ic-engine version
```

`--json` prints one JSON object on stdout and nothing else, so it can be piped. Without it, each
command prints a short human summary. Exit codes are part of the contract because CI branches on them:

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| 0    | Success                                                     |
| 1    | Indexing failed for a reason inside the repository or model |
| 2    | Usage error, which is clap's own convention                 |
| 3    | The database was unreachable                                |

```rust
// crates/ic-engine/src/python.rs, behind the existing `python` feature
create_exception!(ic_engine, EngineError, PyException);
create_exception!(ic_engine, IndexFailed, EngineError);
create_exception!(ic_engine, DatabaseUnavailable, EngineError);
create_exception!(ic_engine, ModelUnavailable, EngineError);

#[pyclass(frozen, get_all, module = "ic_engine")]
pub struct IndexStats {
    pub files_scanned: usize,
    pub files_skipped: usize,
    pub files_indexed: usize,
    pub files_unchanged: usize,
    pub files_removed: usize,
    pub chunks_written: usize,
    pub embeddings_written: usize,
    pub bytes_read: u64,
    pub root_hash: String,
    pub elapsed_ms: u64,
    pub peak_rss_bytes: u64,
}

#[pyfunction]
#[pyo3(signature = (
    root, *, repository_id, run_id, database_url, previous_run_id = None,
    embeddings = true, concurrency = 0, max_file_bytes = 1_048_576,
    model_cache_dir = None, offline = false,
))]
fn index(py: Python<'_>, root: PathBuf, /* ... */) -> PyResult<IndexStats>;

#[pyfunction]
#[pyo3(signature = (root, *, max_file_bytes = 1_048_576))]
fn walk(py: Python<'_>, root: PathBuf, max_file_bytes: usize) -> PyResult<WalkSummary>;

#[pyfunction]
fn version() -> &'static str;
```

Everything except `root` is keyword-only, so a call site cannot silently swap `repository_id` and
`run_id`, which are both UUID strings and would otherwise be interchangeable at the call and wrong in
the database.

`index` and `walk` wrap their entire body in `py.allow_threads(|| ...)`. UUIDs cross as strings and are
parsed inside the boundary, raising `ValueError` on a malformed one, because accepting Python's
`uuid.UUID` would mean a conversion that fails at a less obvious place.

Error mapping, which is the only place `IndexError` is interpreted:

| `IndexError` variant                    | Python exception      | CLI exit |
| --------------------------------------- | --------------------- | -------- |
| `DatabaseUnavailable`, `UnknownRun`     | `DatabaseUnavailable` | 3        |
| `Embed(ModelNotCached)`, `Embed(Fetch)` | `ModelUnavailable`    | 1        |
| everything else                         | `IndexFailed`         | 1        |

The stub, committed and packaged:

```python
# crates/ic-engine/ic_engine.pyi
from pathlib import Path

class IndexStats:
    files_scanned: int
    chunks_written: int
    root_hash: str
    elapsed_ms: int
    peak_rss_bytes: int

class EngineError(Exception): ...
class IndexFailed(EngineError): ...
class DatabaseUnavailable(EngineError): ...
class ModelUnavailable(EngineError): ...

def index(
    root: str | Path,
    *,
    repository_id: str,
    run_id: str,
    database_url: str,
    previous_run_id: str | None = None,
    embeddings: bool = True,
    concurrency: int = 0,
    max_file_bytes: int = 1_048_576,
    model_cache_dir: str | None = None,
    offline: bool = False,
) -> IndexStats: ...
def version() -> str: ...
```

The parity test extends the version check that
`docs/issues/epic-1-data/110-engine-python-parity-test.md` established, in the same file layout and
with the same skip-when-not-built behaviour:

```python
# services/brain/tests/test_engine_index_parity.py
@pytest.mark.integration
def test_cli_and_module_report_identical_stats(tmp_path: Path) -> None:
    """Index one fixture twice, once through the binary and once in process."""
```

Both runs use separate `run_id` values against the same repository, and the comparison excludes
`elapsed_ms` and `peak_rss_bytes`, which are measurements rather than results.

### Files

- CREATE `crates/ic-engine/ic_engine.pyi`
- CREATE `crates/ic-engine/src/python.rs` - the module, moved out of `lib.rs` now that it is more than one function
- CREATE `crates/ic-engine/src/cli.rs` - argument parsing and the exit-code mapping, so both are testable
- CREATE `services/brain/tests/test_engine_index_parity.py`
- MODIFY `crates/ic-engine/src/main.rs` - delegate to `cli::run` and return its exit code
- MODIFY `crates/ic-engine/src/lib.rs` - replace the inline `python` module with the new one
- MODIFY `crates/ic-engine/tests/cli.rs` - cover the new subcommands, `--json`, and the exit codes
- MODIFY `crates/ic-engine/pyproject.toml` - include the stub and a `py.typed` marker in the wheel
- MODIFY `crates/ic-engine/README.md` - document both entry points side by side
- MODIFY `services/brain/README.md` - how to build the wheel locally and what the exceptions mean

### Acceptance Criteria

- [ ] `ic-engine index --json` prints exactly one JSON object, and nothing else, on stdout
- [ ] `ic-engine index` against an unreachable database exits 3, and an unknown flag exits 2
- [ ] `ic_engine.index` and `ic-engine index` produce identical stats for the same fixture, ignoring the two timing fields
- [ ] `ic_engine.index` raises `DatabaseUnavailable`, a subclass of `EngineError`, rather than a bare `RuntimeError`
- [ ] `ic_engine.index` raises `ValueError` for a malformed UUID string, before any work starts
- [ ] An asyncio heartbeat keeps ticking while `ic_engine.index` runs, proving the GIL is released
- [ ] Passing `repository_id` positionally is a `TypeError`
- [ ] `uv run --directory services/brain mypy` passes on a module that imports and calls `ic_engine`
- [ ] `ic_engine.version()` still equals the `ic-engine --version` output

### Required Tests

- `cli_index_prints_one_json_object`
- `cli_exits_two_on_an_unknown_flag`
- `cli_exits_three_when_the_database_is_unreachable`
- `test_cli_and_module_report_identical_stats`
- `test_module_raises_database_unavailable_rather_than_runtime_error`
- `test_module_rejects_a_malformed_uuid_before_starting`
- `test_event_loop_keeps_running_while_indexing`
- `test_module_requires_keyword_arguments_for_ids`
- `test_python_module_reports_same_version_as_the_cli`

### Performance Budget

The in-process path stays within 5% of the binary's wall time on the small fixture, measured by the
parity test, which is the whole justification for the extension module. `import ic_engine` completes in
under 250ms, because it happens on the brain's first request after a cold start.

### Out of Scope

- Do not change anything in `index.rs`, `walk.rs`, `chunk.rs`, or `embed/`. If a signature needs
  changing to make the boundary work, that is a defect in the earlier issue and belongs there
- Do not add retrieval, graph, or query commands to the CLI. This issue exposes what the engine already does
- Do not publish the wheel to PyPI or the crate to crates.io
- Do not call the engine from `services/brain/src/brain/app.py`. Wiring ingest into a route needs the
  job queue in #28 and the worker in #29
- Do not add an async Python API. `asyncio.to_thread` over a GIL-releasing call is the supported pattern
  and needs no code here

### Dependencies

Blocked by `docs/issues/epic-3-engine/040-index-writes-to-postgres.md`. Builds on the maturin setup
from #31 and the parity test harness from #30.

### Verification

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-features --workspace
maturin build -m crates/ic-engine/Cargo.toml --release
uv pip install --directory services/brain target/wheels/ic_engine-*.whl
uv run --directory services/brain pytest tests/test_engine_index_parity.py -v
uv run --directory services/brain mypy
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
