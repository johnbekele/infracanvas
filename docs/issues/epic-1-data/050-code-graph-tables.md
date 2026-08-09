---
title: '[db] Code property graph node and edge tables'
labels: tier:2, size:s, area:db, epic:1-data
---

### Epic

#2

### Context

Vector search alone answers "what looks like this query". It cannot answer "what breaks if I change
this function", which is the question that matters when proposing an architecture for an existing
codebase. That needs edges: which symbol calls which, which module imports which, which handler
serves which route.

Storing the graph in the same database as the chunks is what makes this cheap. A retrieval query can
expand from a matched chunk to its callers in one SQL statement rather than a round trip to a
separate graph service.

Postgres is not a graph database, and it does not need to be. The traversals here are bounded to two
or three hops from a seed set, which a recursive CTE handles well. A dedicated graph engine would
buy unbounded traversal we do not perform, at the cost of a second system to install.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TYPE graph_node_kind AS ENUM (
  'file', 'module', 'class', 'function', 'method', 'route', 'table', 'queue', 'external_service'
);

CREATE TYPE graph_edge_kind AS ENUM (
  'imports', 'calls', 'defines', 'references', 'handles', 'reads', 'writes', 'publishes', 'subscribes'
);

CREATE TABLE graph_nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  kind          graph_node_kind NOT NULL,
  -- Stable within a run: "path/to/file.ts::ClassName::methodName".
  qualified_name text NOT NULL,
  display_name  text NOT NULL,
  file_id       uuid REFERENCES files (id) ON DELETE CASCADE,
  start_line    integer,
  end_line      integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, qualified_name)
);

CREATE INDEX graph_nodes_repository_idx ON graph_nodes (repository_id, kind);

CREATE TABLE graph_edges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  source_id     uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  target_id     uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  kind          graph_edge_kind NOT NULL,
  weight        real NOT NULL DEFAULT 1.0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_id, target_id, kind),
  CHECK (source_id <> target_id)
);

-- Traversal runs in both directions: "what does this call" and "what calls this".
CREATE INDEX graph_edges_source_idx ON graph_edges (source_id, kind);
CREATE INDEX graph_edges_target_idx ON graph_edges (target_id, kind);
```

```typescript
export function insertNodes(runId: string, nodes: NewGraphNode[]): Promise<GraphNode[]>;
export function insertEdges(runId: string, edges: NewGraphEdge[]): Promise<number>;
/** Breadth-first expansion from a seed set, bounded by hop count. */
export function neighbourhood(
  nodeIds: readonly string[],
  depth: number,
  kinds?: readonly GraphEdgeKind[]
): Promise<GraphNode[]>;
```

### Files

- CREATE `db/migrations/<timestamp>_code_graph.sql`
- CREATE `apps/api/src/lib/db/graph.ts`
- CREATE `apps/api/src/lib/db/graph.integration.test.ts`

### Acceptance Criteria

- [ ] A node may not be inserted twice with the same `qualified_name` within one run
- [ ] The same `qualified_name` may exist in two different runs of the same repository
- [ ] A self-edge is rejected by the database
- [ ] Duplicate edges of the same kind between the same pair are rejected within a run
- [ ] `neighbourhood` with depth 1 returns direct neighbours in both directions
- [ ] `neighbourhood` terminates on a cyclic graph rather than looping
- [ ] `neighbourhood` filtered by edge kind ignores edges of other kinds
- [ ] Deleting a run removes its nodes and edges

### Required Tests

- `rejects a duplicate qualified name within a run`
- `allows the same qualified name in a later run`
- `rejects a self edge`
- `rejects a duplicate edge of the same kind`
- `expands to direct neighbours in both directions`
- `terminates on a cycle`
- `respects an edge kind filter`
- `cascades deletion from run to nodes and edges`

### Performance Budget

`neighbourhood` at depth 2 from 20 seed nodes returns in under 100ms on a graph of 100k nodes and
400k edges.

### Out of Scope

- Do not implement graph extraction from source code; that is the Rust engine's work
- Do not implement community detection or summarisation; those belong to the Graph RAG epic
- Do not add a recursive traversal without a depth bound

### Dependencies

Blocked by #25.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm --filter @infracanvas/api test:integration
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
