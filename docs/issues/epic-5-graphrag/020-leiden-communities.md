---
title: '[rust] Leiden community detection over the code graph'
labels: tier:2, size:l, area:rust, area:db, epic:5-graphrag
---

### Epic

#6

### Context

Graph RAG answers architecture-level questions by summarising clusters of related code rather than
individual chunks, so something has to decide what a cluster is. Community detection does that: it
partitions the extracted graph into groups that talk to each other far more than to the rest of the
repository, which in practice recovers the modules a codebase has rather than the directories
someone once created.

This runs in memory in Rust, not in Postgres. Community detection is not a traversal, which is what
a recursive CTE is good at. Leiden iterates over the whole graph many times, moving nodes between
communities and then collapsing the graph and doing it again. Expressing that in SQL means either a
statement per iteration rewriting a working table, which is dozens of round trips and gigabytes of
write-ahead log for a graph that fits in tens of megabytes of RAM, or a PL/pgSQL loop that holds a
transaction open for minutes and blocks vacuum while it runs. A graph of 100,000 nodes and 400,000
edges is roughly 20 MB as a `petgraph::Graph<u32, f32>`, so the whole job is one read, one
CPU-bound pass, and one bulk write of the assignment.

Leiden rather than Louvain, despite Louvain being simpler and having more ready implementations.
Louvain can produce internally disconnected communities: a group whose members do not reach one
another through the group's own edges. That is a curiosity in a citation network and a defect here,
because the next issue turns each community into a summary shown to a user, and a summary of an
arbitrary set of unrelated functions is worse than no summary. Leiden's refinement phase guarantees
every community is internally connected, and it reaches higher modularity in comparable time. The
cost is that no maintained Rust crate implements it at the quality needed, so the algorithm is
written here on top of `petgraph`'s graph types, which is roughly four hundred lines.

Quality is measured with the Constant Potts Model rather than modularity. Modularity has a
resolution limit that makes it merge genuinely separate small modules once the graph is large,
which on a big repository yields three enormous communities and nothing useful to summarise. CPM
takes a resolution parameter that sets community size directly and does not degrade as the graph
grows.

Determinism is a requirement, not a nicety. Leiden's local moving phase depends on visit order and
on randomness, and the summaries built from these communities are cached and cited. If two ingests
of the same commit produce different communities, every cached summary and every citation is
invalidated for no reason a user can see. Nodes are therefore visited in `qualified_name` order and
the random number generator is a seeded `StdRng`.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TABLE graph_communities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  -- 0 is the finest partition; each level above aggregates the one below.
  level         smallint NOT NULL,
  parent_id     uuid REFERENCES graph_communities (id) ON DELETE CASCADE,
  -- Stable within (run, level): assigned in ascending order of the smallest
  -- member qualified_name, so an ordinal means the same thing across runs.
  ordinal       integer NOT NULL,
  node_count    integer NOT NULL,
  quality       real NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, level, ordinal),
  CHECK (level >= 0 AND node_count > 0)
);

CREATE INDEX graph_communities_repository_idx ON graph_communities (repository_id, level);

CREATE TABLE graph_community_members (
  community_id uuid NOT NULL REFERENCES graph_communities (id) ON DELETE CASCADE,
  node_id      uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  PRIMARY KEY (community_id, node_id)
);

-- Retrieval asks "which community is this node in", which is the reverse of
-- the primary key's order.
CREATE INDEX graph_community_members_node_idx ON graph_community_members (node_id);
```

```rust
// crates/ic-engine/src/communities/mod.rs

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LeidenConfig {
    /// CPM resolution. Higher yields more, smaller communities. The default
    /// was chosen to put a typical module in one community on the fixture
    /// corpus; changing it means rerunning that measurement.
    pub resolution: f64,
    /// Stop aggregating past this many levels even if quality still improves.
    pub max_levels: u8,
    /// Seeded so two runs over the same commit partition identically.
    pub seed: u64,
    /// Communities below this size are merged into their strongest neighbour
    /// rather than summarised on their own.
    pub min_community_size: usize,
    /// Give up on a level once an iteration improves quality by less than this.
    pub tolerance: f64,
}

impl Default for LeidenConfig {
    fn default() -> Self {
        Self {
            resolution: 0.05,
            max_levels: 3,
            seed: 0x1c_ca_11_5e,
            min_community_size: 3,
            tolerance: 1e-6,
        }
    }
}

/// Weighted, undirected view of the extracted graph. Direction is dropped
/// because "A calls B" and "B calls A" are the same evidence of belonging
/// together; the weights differ by edge kind instead.
pub struct CodeGraph {
    pub node_names: Vec<String>,
    pub graph: petgraph::graph::UnGraph<u32, f32>,
}

impl CodeGraph {
    /// `imports` and `extends` weigh 2.0, `calls` 1.0, and the heuristic kinds
    /// 0.5, because a guessed edge should not decide a module boundary.
    pub fn from_extracted(extracted: &ExtractedGraph) -> Self;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Community {
    pub level: u8,
    pub ordinal: u32,
    pub parent_ordinal: Option<u32>,
    /// Member qualified names, sorted.
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Communities {
    pub communities: Vec<Community>,
    /// CPM quality per level, index 0 being the finest partition.
    pub quality: Vec<f64>,
}

/// Local moving, refinement, aggregation, repeated per level.
///
/// Guarantees: every node belongs to exactly one community per level, every
/// community is internally connected, and the result is a pure function of the
/// graph and the config.
#[must_use]
pub fn detect_communities(graph: &CodeGraph, config: LeidenConfig) -> Communities;

/// Quality of a partition under the Constant Potts Model.
#[must_use]
pub fn cpm_quality(graph: &CodeGraph, membership: &[u32], resolution: f64) -> f64;
```

```rust
#[cfg(feature = "python")]
#[pyfunction]
fn detect_communities_json(graph_json: &str, resolution: f64, seed: u64) -> PyResult<String>;
```

### Files

- CREATE `db/migrations/<timestamp>_graph_communities.sql` - both tables with a `migrate:down`
- CREATE `crates/ic-engine/src/communities/mod.rs` - types, config, `detect_communities`
- CREATE `crates/ic-engine/src/communities/leiden.rs` - local moving, refinement, aggregation
- CREATE `crates/ic-engine/src/communities/quality.rs` - CPM quality and connectivity checks
- CREATE `crates/ic-engine/tests/communities.rs`
- CREATE `crates/ic-engine/tests/fixtures/communities/` - graphs with a known correct partition
- CREATE `crates/ic-engine/benches/communities.rs`
- CREATE `apps/api/src/lib/db/communities.ts` - insert and read helpers
- CREATE `apps/api/src/lib/db/communities.integration.test.ts`
- MODIFY `crates/ic-engine/Cargo.toml` - add `petgraph` and `rand`, and the `communities` bench
- MODIFY `crates/ic-engine/src/lib.rs` - declare the `communities` module

### Acceptance Criteria

- [ ] On a fixture of three cliques joined by single edges, level 0 is exactly those three communities
- [ ] Every community at every level is internally connected, checked by a traversal within the community's own induced subgraph
- [ ] Two runs with the same seed produce identical communities, including ordinals
- [ ] Two runs with different seeds produce partitions whose CPM quality differs by less than 1%
- [ ] Shuffling the input node order does not change the resulting partition
- [ ] Raising `resolution` produces more communities and lowering it produces fewer, on the same graph
- [ ] Every node appears in exactly one community per level, and levels above 0 partition the level below
- [ ] A community smaller than `min_community_size` is merged into its strongest neighbour rather than emitted
- [ ] An isolated node with no edges is emitted in its own community rather than dropped or crashing the run
- [ ] An empty graph returns zero communities rather than panicking
- [ ] `quality` reported per level is non-decreasing from the initial singleton partition
- [ ] The migration applies, rolls back, and reapplies on `pgvector/pgvector:pg17`

### Required Tests

- `recovers three cliques as three communities`
- `produces only internally connected communities`
- `is deterministic for a fixed seed`
- `is stable in quality across seeds`
- `is invariant to input node order`
- `produces more communities at a higher resolution`
- `partitions every node exactly once per level`
- `merges a community below the minimum size into its neighbour`
- `keeps an isolated node in its own community`
- `returns no communities for an empty graph`
- `never lowers quality below the singleton partition`

### Performance Budget

100,000 nodes and 400,000 edges partitioned in under 5 s single-threaded, measured with
`cargo bench --bench communities`. Peak resident memory for that graph stays under 250 MB, measured
with `/usr/bin/time -l`. Loading the graph out of Postgres is one query per table, not one per node.

### Out of Scope

- Do not run community detection in SQL, and do not add a recursive CTE for it
- Do not add a graph database or an external clustering service
- Do not summarise communities; that is
  `docs/issues/epic-5-graphrag/030-community-summaries-with-citations.md`
- Do not change the extraction rules or edge kinds from
  `docs/issues/epic-5-graphrag/010-graph-extraction.md`; if a weight is wrong, change the weight
- Do not implement incremental re-clustering on partial ingests

### Dependencies

Blocked by #26 and by `docs/issues/epic-5-graphrag/010-graph-extraction.md`. Also depends on #31.

### Verification

```bash
cargo test -p ic-engine
cargo clippy --all-targets -- -D warnings
cargo bench --bench communities
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm --filter @infracanvas/api test:integration
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
