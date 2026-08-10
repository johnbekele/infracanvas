---
title: '[rust] Extract code graph nodes and edges from the parsed AST'
labels: tier:2, size:l, area:rust, area:db, epic:5-graphrag
---

### Epic

#6

### Context

#26 created the tables for a code property graph and nothing fills them. This issue is the producer:
it walks the syntax trees the parser already builds and emits the nodes and edges that make
"what breaks if I change this" answerable.

Extraction lives in `crates/ic-engine` beside the parser rather than in the brain, because it is
the only place the syntax trees exist. Sending trees across the PyO3 boundary to walk them in
Python would serialise the entire parse of a repository to save writing Rust, and would put the
most allocation-heavy pass of the ingest in the slowest runtime available.

Per-language rules are tree-sitter queries in `.scm` files, not `match` arms over node kinds. A
query is data: adding Ruby means adding a file and a fixture, whereas the hand-written walk grows a
few hundred lines of pattern matching per language and every one of them has to be reread when a
grammar is upgraded. The cost is that a query is harder to debug than a function, which is why
every query file has a fixture whose expected output is committed next to it.

Six edge kinds are extracted, and they are not all the same sort of claim. `imports`, `calls`, and
`extends` are read from the grammar and are as correct as the parse. `reads_env`, `http_call`, and
`db_query` are recognised from call shapes such as `os.environ[...]`, `fetch(...)`, or
`pool.query(...)`, and they are heuristics that will produce false positives. That is acceptable
only because every edge carries the file and line it was derived from, so a wrong edge is a link a
human can open rather than an assertion they have to trust. Any edge that cannot state its source
location is dropped rather than emitted.

References that resolve to nothing in the repository are the awkward case. A call to `fetch` has no
definition to point at, and the `graph_edges` foreign keys forbid a dangling target. Inventing a
node per unresolved identifier would fill the graph with noise, so a plain unresolved call is
dropped and counted in a report the ingest surfaces. The three heuristic kinds are the exception:
their whole value is that the target is outside the repository, so they attach to synthetic nodes,
which needs `env_var` added to `graph_node_kind` and the four missing values added to
`graph_edge_kind`. That migration is part of this issue because the engine cannot emit an edge kind
the database will reject.

Spec: `docs/DATABASE.md`

### Contract

```sql
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
-- so this migration runs outside one.
-- migrate:up transaction:false
ALTER TYPE graph_edge_kind ADD VALUE IF NOT EXISTS 'extends';
ALTER TYPE graph_edge_kind ADD VALUE IF NOT EXISTS 'reads_env';
ALTER TYPE graph_edge_kind ADD VALUE IF NOT EXISTS 'http_call';
ALTER TYPE graph_edge_kind ADD VALUE IF NOT EXISTS 'db_query';
ALTER TYPE graph_node_kind ADD VALUE IF NOT EXISTS 'env_var';

-- The provenance of a heuristic edge. Without it a false positive is
-- indistinguishable from a fact.
ALTER TABLE graph_edges ADD COLUMN source_path text;
ALTER TABLE graph_edges ADD COLUMN source_line integer;
ALTER TABLE graph_edges ADD CONSTRAINT graph_edges_provenance_ck
  CHECK ((source_path IS NULL) = (source_line IS NULL));

-- migrate:down
-- Postgres cannot drop an enum value. The down path recreates both types
-- without the added values, which requires deleting the rows that use them.
-- This is destructive and is written out in full in the migration.
```

```rust
// crates/ic-engine/src/graph/mod.rs

/// What an edge asserts. `Imports`, `Calls`, and `Extends` are read from the
/// grammar. The rest are recognised from call shapes and are heuristics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeKind {
    Imports,
    Calls,
    Extends,
    ReadsEnv,
    HttpCall,
    DbQuery,
}

impl EdgeKind {
    /// The `graph_edge_kind` label this maps to. The database rejects anything
    /// else, so this is the single place the two vocabularies meet.
    #[must_use]
    pub fn as_str(self) -> &'static str;

    /// True for kinds derived from call shapes rather than from the grammar.
    #[must_use]
    pub fn is_heuristic(self) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeKind {
    File,
    Module,
    Class,
    Function,
    Method,
    Route,
    EnvVar,
    ExternalService,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNode {
    /// "path/to/file.ts::ClassName::methodName", the shape #26 makes unique
    /// within a run.
    pub qualified_name: String,
    pub display_name: String,
    pub kind: NodeKind,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
    pub weight: f32,
    /// Where the edge was read from, always populated.
    pub source_path: String,
    pub source_line: u32,
}

/// A reference that named something the repository does not define.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvedRef {
    pub name: String,
    pub kind: EdgeKind,
    pub occurrences: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExtractedGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub unresolved: Vec<UnresolvedRef>,
}

/// Extract in two passes: every definition first, so that resolution in the
/// second pass can see a symbol defined in a file parsed later.
///
/// Deterministic: nodes are emitted in (path, start_line) order and edges in
/// (source, target, kind) order, so two runs over the same commit produce
/// byte-identical output.
pub fn extract_graph(files: &[ParsedFile]) -> ExtractedGraph;
```

```rust
// Exposed to the brain through the existing PyO3 module, feature-gated as the
// rest of the module is.
#[cfg(feature = "python")]
#[pyfunction]
fn extract_graph_json(files_json: &str) -> PyResult<String>;
```

Language rules live in `crates/ic-engine/queries/<language>/graph.scm`, one file per language
supported by `docs/issues/epic-3-engine/020-tree-sitter-parsing-and-chunking.md`. Follow the set
that issue lands rather than a list frozen here, and add a fixture for each language it supports.

### Files

- CREATE `db/migrations/<timestamp>_graph_extraction_kinds.sql`
- CREATE `crates/ic-engine/src/graph/mod.rs` - types and `extract_graph`
- CREATE `crates/ic-engine/src/graph/resolve.rs` - two-pass symbol resolution
- CREATE `crates/ic-engine/src/graph/heuristics.rs` - `reads_env`, `http_call`, `db_query`
- CREATE `crates/ic-engine/queries/<language>/graph.scm` - one per supported language
- CREATE `crates/ic-engine/tests/fixtures/graph/<language>/` - source input and expected JSON output
- CREATE `crates/ic-engine/tests/graph_extraction.rs`
- MODIFY `crates/ic-engine/src/lib.rs` - declare the `graph` module and re-export its public types
- MODIFY `crates/ic-engine/src/main.rs` - an `extract-graph` subcommand printing the JSON

### Acceptance Criteria

- [ ] For every supported language, extraction over its fixture produces exactly the committed expected nodes and edges
- [ ] A call to a function defined in another file of the same repository produces one `calls` edge to that definition
- [ ] A call to a symbol the repository does not define produces no edge and one `UnresolvedRef` entry with the occurrence count
- [ ] A class inheriting from a class in the same repository produces an `extends` edge, and inheriting from an imported external base produces none
- [ ] `os.environ["DATABASE_URL"]`, `process.env.DATABASE_URL`, and `std::env::var("DATABASE_URL")` each produce a `reads_env` edge to one `env_var` node named `DATABASE_URL`
- [ ] Every emitted edge has a non-empty `source_path` and a `source_line` within the file's line count
- [ ] Two runs over the same fixture produce byte-identical JSON, including ordering
- [ ] A file that fails to parse yields no nodes and no edges for that file and does not abort extraction of the others
- [ ] A recursive function produces no self-edge, since `graph_edges` rejects one
- [ ] The migration applies, rolls back, and reapplies on `pgvector/pgvector:pg17`
- [ ] Extraction never panics on the malformed and truncated source files in the fixtures

### Required Tests

- `extracts the expected nodes and edges for every language fixture`
- `resolves a call to a definition in a file parsed later`
- `records an unresolved reference rather than emitting a dangling edge`
- `emits an extends edge only for a base class defined in the repository`
- `recognises environment reads in every supported language`
- `attaches a file and line to every emitted edge`
- `produces identical output on a second run`
- `skips an unparseable file without aborting the run`
- `never emits a self edge for a recursive function`
- `does not panic on truncated source`

### Performance Budget

Extraction adds no more than 25% to tree-sitter parse wall time over the fixture corpus, measured
with `cargo bench --bench ingest` before and after. Peak resident memory for a 20,000-file
repository stays under 600 MB, measured with `/usr/bin/time -l target/release/ic-engine
extract-graph`. Output is streamed per file rather than accumulated as one string.

### Out of Scope

- Do not write to Postgres from Rust; extraction returns values and persistence is the ingestion
  worker's job through the helpers in #26
- Do not change the parser or the chunker from
  `docs/issues/epic-3-engine/020-tree-sitter-parsing-and-chunking.md`
- Do not implement community detection or summarisation; both have their own issues
- Do not add cross-repository or cross-run symbol resolution
- Do not add type inference; resolution is by name and scope only

### Dependencies

Blocked by #26, and by the parser in
`docs/issues/epic-3-engine/020-tree-sitter-parsing-and-chunking.md`. Also depends on #31 for the
Rust toolchain.

### Verification

```bash
cargo test -p ic-engine
cargo clippy --all-targets -- -D warnings
cargo bench --bench ingest
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
