---
title: '[rust] Index a repository into Postgres with incremental re-indexing'
labels: tier:2, size:l, area:rust, epic:3-engine
---

### Epic

#4

### Context

This is the issue that turns three libraries into the pipeline the rest of the product calls.
`ic_engine::index` walks a checkout, chunks what it finds, embeds the chunks, and writes files, chunks,
and embeddings for one ingestion run. It is also where the epic's headline budgets are either met or
not, so it owns the perf fixture and the Gate 6 wiring rather than leaving them to whoever notices
first.

Writes go through `COPY ... FROM STDIN BINARY` rather than batched `INSERT`. At roughly 45k chunks and
45k embeddings for the perf fixture, per-row round trips are the difference between a write stage of
about fifteen seconds and one of several minutes, and a 384-dimension `halfvec` is large enough that
text-mode encoding is wasteful on its own. Chunk ids are generated in the engine as UUIDv7 rather than
by the `gen_random_uuid()` default, because a chunk and its embedding must be written in the same pass
and the engine cannot learn a server-generated id from a `COPY`. Time-ordered ids also keep the
primary key inserts local, which matters at this row count.

Unchanged files are copied forward inside the database rather than re-parsed and re-embedded. #25
makes `files` unique per `(run_id, path)`, so a new run needs its own rows even for files that did not
change; the alternative would be reusing the previous run's rows, which breaks the guarantee that a run
is a complete snapshot of one commit. Copying forward with one `INSERT ... SELECT` per file means an
unchanged file costs a server-side row copy and no CPU on the client, which is where the five-second
re-index budget comes from. The cost is duplicated chunk text across runs. Content-addressed chunks
shared between runs would fix that and require changing the schema in #25, so it is deliberately left
as a follow-up for whenever storage rather than ingest time becomes the constraint.

The database client is the synchronous `postgres` crate, not `tokio-postgres`. Indexing is CPU-bound
and already parallel across threads, so an async API buys nothing, and it would force the brain to
bridge asyncio and tokio for a call that is going to be made from inside `py.allow_threads` anyway.

The engine does not touch `ingestion_runs`. It is given a `run_id` and returns `IndexStats`; the caller
sets `status`, `started_at`, and the counts through the functions #24 defines. Two writers on that row,
one of them a Rust process that may be killed mid-run, is how a run ends up `succeeded` with half its
chunks.

Spec: `docs/DATABASE.md`

### Contract

```rust
// crates/ic-engine/src/index.rs
pub enum EmbedderChoice {
    Local { cache_dir: Option<PathBuf>, offline: bool },
    /// Writes chunks and no embeddings. For tests and for measuring the other stages.
    Disabled,
}

pub struct IndexOptions {
    pub root: PathBuf,
    pub repository_id: Uuid,
    /// The run this snapshot belongs to. Created by the caller, never by the engine.
    pub run_id: Uuid,
    /// Previous succeeded run. Its `files` rows are the baseline for the incremental path.
    pub previous_run_id: Option<Uuid>,
    pub database_url: String,
    pub engine: EngineConfig,
    pub chunking: ChunkOptions,
    pub embedder: EmbedderChoice,
    /// Files per transaction. Default 256. A crash leaves whole files, never half of one.
    pub files_per_transaction: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IndexStats {
    pub files_scanned: usize,
    pub files_skipped: usize,
    /// Parsed, chunked, and embedded in this run.
    pub files_indexed: usize,
    /// Copied forward from `previous_run_id` without parsing.
    pub files_unchanged: usize,
    pub files_removed: usize,
    pub chunks_written: usize,
    pub embeddings_written: usize,
    pub bytes_read: u64,
    /// Merkle root from the walk, so a caller can short-circuit an identical commit.
    pub root_hash: String,
    pub elapsed_ms: u64,
    /// From `VmHWM` on Linux and `ru_maxrss` elsewhere. Zero when unavailable.
    pub peak_rss_bytes: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error(transparent)]
    Walk(#[from] WalkError),
    #[error(transparent)]
    Chunk(#[from] ChunkError),
    #[error(transparent)]
    Embed(#[from] EmbedError),
    #[error("database unavailable: {0}")]
    DatabaseUnavailable(String),
    #[error("run {0} does not exist")]
    UnknownRun(Uuid),
    #[error("embedder produced {actual} dimensions, the column expects {expected}")]
    DimensionMismatch { actual: usize, expected: usize },
}

/// Blocking. Safe to call from `py.allow_threads`, which is how the brain reaches it.
pub fn index(options: IndexOptions) -> Result<IndexStats, IndexError>;
```

The write path, in order:

```sql
-- Per batch, inside one transaction.
COPY files (id, repository_id, run_id, path, language, size_bytes, sha256) FROM STDIN BINARY;
COPY chunks (id, file_id, repository_id, start_line, end_line, symbol, kind, content, token_count)
  FROM STDIN BINARY;
COPY chunk_embeddings (chunk_id, repository_id, model, embedding) FROM STDIN BINARY;
```

`chunks.content_tsv` is a generated column and is never listed. The embedding is written as
`halfvec` through the `pgvector` crate's half-precision type, and `index` checks
`embedder.dim()` against 384 before the first write so a wrong model fails immediately rather than on
the first `COPY`.

The copy-forward for an unchanged file, which is the whole of the incremental path:

```sql
WITH mapped AS (
  SELECT c.*, gen_random_uuid() AS new_id
    FROM chunks c
   WHERE c.file_id = $1        -- the previous run's file row
), inserted AS (
  INSERT INTO chunks (id, file_id, repository_id, start_line, end_line, symbol, kind,
                      content, token_count)
  SELECT new_id, $2, repository_id, start_line, end_line, symbol, kind, content, token_count
    FROM mapped
)
INSERT INTO chunk_embeddings (chunk_id, repository_id, model, embedding)
SELECT m.new_id, e.repository_id, e.model, e.embedding
  FROM mapped m
  JOIN chunk_embeddings e ON e.chunk_id = m.id;
```

The baseline manifest for the diff is reconstructed from the previous run rather than stored anywhere
new, which keeps this issue free of a migration:

```rust
/// Builds a `RepoManifest` from `files` so `RepoManifest::diff` can classify the new walk.
/// `root_hash` is read back from the previous run's recorded value where present, and left empty
/// otherwise, in which case every file is treated as added.
fn manifest_from_run(client: &mut Client, run_id: Uuid) -> Result<RepoManifest, IndexError>;
```

The CLI gains the minimum needed to measure the pipeline; the full surface is
`docs/issues/epic-3-engine/050-cli-and-pyo3-parity.md`:

```text
ic-engine index <path> --repository-id <uuid> --run-id <uuid> [--previous-run-id <uuid>]
                       [--database-url <url>] [--no-embeddings] [--json]
```

`--database-url` falls back to `DATABASE_URL`. `--json` prints `IndexStats` as one JSON object on
stdout, which is what the Gate 6 step reads.

Integration tests read `TEST_DATABASE_URL` and skip when it is absent, so a clone with no Postgres
still gets a green `cargo test`. The helper that reads it panics instead of skipping when `CI` is set,
because a suite that is green because it silently did nothing is worse than a red one.

### Files

- CREATE `crates/ic-engine/src/index.rs`
- CREATE `crates/ic-engine/src/db.rs` - connection setup, the `COPY` writers, and the copy-forward statement
- CREATE `crates/ic-engine/src/rss.rs` - peak RSS, per platform
- CREATE `crates/ic-engine/tests/index.rs`
- CREATE `scripts/fixtures/generate-large-repo.mjs` - deterministic 100k-file fixture generator
- CREATE `scripts/ci/seed-perf-run.sql` - fixed-uuid user, repository, and ingestion run for Gate 6
- MODIFY `crates/ic-engine/src/lib.rs` - declare and re-export `index`, `IndexOptions`, `IndexStats`
- MODIFY `crates/ic-engine/src/main.rs` - add the `index` subcommand
- MODIFY `crates/ic-engine/Cargo.toml` - add `postgres`, `pgvector`, `uuid`, `serde`, and `serde_json`
- MODIFY `.github/workflows/gate-test.yml` - give the `test-rust` job a `pgvector/pgvector:pg17`
  service, apply migrations, and set `TEST_DATABASE_URL`
- MODIFY `.github/workflows/gate-perf.yml` - guard `ingest-performance` on the fixture generator rather
  than on the fixture directory, generate the fixture, add the Postgres service, apply migrations, and
  seed the run before the RSS assertion
- MODIFY `.gitignore` - ignore `tests/fixtures/repos/large`
- MODIFY `crates/ic-engine/README.md` - document `index`, the incremental path, and how to generate the fixture

### Acceptance Criteria

- [ ] Indexing a fixture checkout writes one `files` row per indexed file, its chunks, and one embedding per chunk
- [ ] `IndexStats` counts match the rows actually present for that `run_id`
- [ ] Re-indexing an unchanged checkout into a new run parses and embeds nothing, and `files_unchanged` equals `files_scanned` minus `files_skipped`
- [ ] Copied-forward chunks have new ids and identical `content`, `symbol`, `kind`, and `embedding` values
- [ ] A file deleted between runs appears in neither the new run's `files` rows nor `chunks`, and increments `files_removed`
- [ ] A modified file's previous chunks are not carried into the new run
- [ ] An error partway through a batch leaves no `files` row for that batch, and no chunk without its file
- [ ] `index` returns `IndexError::DatabaseUnavailable` rather than panicking when the database refuses the connection
- [ ] `index` returns `IndexError::DimensionMismatch` before any write when the embedder does not produce 384 dimensions
- [ ] `EmbedderChoice::Disabled` writes chunks and leaves `chunk_embeddings` untouched
- [ ] `ic-engine index --json` prints one JSON object that parses into `IndexStats`

### Required Tests

- `indexes_a_fixture_and_writes_files_chunks_and_embeddings`
- `stats_counts_match_the_rows_in_the_database`
- `re_indexing_an_unchanged_checkout_parses_and_embeds_nothing`
- `copies_unchanged_chunks_and_embeddings_forward_to_the_new_run`
- `drops_chunks_of_a_file_that_changed`
- `omits_a_deleted_file_from_the_new_run`
- `rolls_back_a_batch_that_fails_partway_through`
- `returns_database_unavailable_rather_than_panicking`
- `rejects_an_embedder_whose_dimension_is_not_384`

### Performance Budget

The whole pipeline indexes the 100k-file fixture in under 120 seconds at under 300MB peak RSS,
asserted by the `ingest-performance` job in Gate 6, which already enforces the 300MB ceiling with
`/usr/bin/time -v`. The stage budgets that add up to it: 10 seconds walking and hashing, 25 seconds
parsing and chunking, 65 seconds embedding, and 20 seconds for the database writes. Re-indexing after
100 changed files completes in under 5 seconds, which is the walk plus 100 files of parse and embed
work plus one copy-forward statement per unchanged file.

### Out of Scope

- Do not write to `ingestion_runs`. The caller owns `status` and the run counters, per #24
- Do not add the durable job queue or progress events; #28 and #29 own the worker and the SSE stream
  that will call this function
- Do not add a migration. The incremental baseline is reconstructed from `files`, and changing #25's
  tables from an engine issue would split ownership of the schema
- Do not implement content-addressed chunk sharing between runs. It is a real improvement and a
  separate decision, recorded above
- Do not add the PyO3 entry point or the remaining CLI subcommands; that is
  `docs/issues/epic-3-engine/050-cli-and-pyo3-parity.md`
- Do not change the `retrieval-latency` or `bundle-size` jobs in `gate-perf.yml`

### Dependencies

Blocked by #24 and #25 for the tables it writes, and by
`docs/issues/epic-3-engine/010-repository-walker-and-merkle-hashing.md`,
`020-tree-sitter-parsing-and-chunking.md`, and `030-local-embeddings.md`.

### Verification

```bash
pnpm db:migrate
cargo fmt --check
cargo clippy --all-targets -- -D warnings
TEST_DATABASE_URL="$DATABASE_URL" cargo test --all-features --workspace
node scripts/fixtures/generate-large-repo.mjs --files 100000 --out tests/fixtures/repos/large
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ci/seed-perf-run.sql
/usr/bin/time -v cargo run --release --bin ic-engine -- index tests/fixtures/repos/large --json
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
