-- migrate:up

CREATE TYPE graph_node_kind AS ENUM (
  'file', 'module', 'class', 'function', 'method', 'route', 'table', 'queue', 'external_service'
);

CREATE TYPE graph_edge_kind AS ENUM (
  'imports', 'calls', 'defines', 'references', 'handles', 'reads', 'writes', 'publishes', 'subscribes'
);

-- One symbol, file or external dependency as a single ingestion pass saw it.
--
-- Keyed by run for the same reason `files` and `chunks` are: a re-index of a
-- newer commit renames, moves and deletes symbols wholesale, and reconciling
-- that against a live graph is far more work than writing a second one beside
-- it and dropping the first. It also means node ids are stable for exactly as
-- long as the run that produced them, so nothing outside a run may cache them.
CREATE TABLE graph_nodes (
  id             uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id  uuid            NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id         uuid            NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  kind           graph_node_kind NOT NULL,
  -- Stable within a run: "path/to/file.ts::ClassName::methodName".
  qualified_name text            NOT NULL,
  display_name   text            NOT NULL,
  -- Null for a node with no source of its own: an external service, a queue, a
  -- table the code only talks to.
  file_id        uuid            REFERENCES files (id) ON DELETE CASCADE,
  start_line     integer,
  end_line       integer,
  created_at     timestamptz     NOT NULL DEFAULT now(),

  UNIQUE (run_id, qualified_name)
);

CREATE INDEX graph_nodes_repository_idx ON graph_nodes (repository_id, kind);

-- Not in the issue's contract, and added because the cascade needs it: without
-- an index on the referencing side, deleting one file makes Postgres scan every
-- node row to find the ones pointing at it.
CREATE INDEX graph_nodes_file_idx ON graph_nodes (file_id);

-- A relationship between two nodes of the same run.
--
-- `weight` carries extraction confidence, or call-site count for a `calls`
-- edge, so ranking can prefer a hot path over an incidental reference. Nothing
-- reads it yet; it is here because backfilling an edge property means re-running
-- extraction over the whole repository.
CREATE TABLE graph_edges (
  id            uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid            NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid            NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  source_id     uuid            NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  target_id     uuid            NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  kind          graph_edge_kind NOT NULL,
  weight        real            NOT NULL DEFAULT 1.0,
  created_at    timestamptz     NOT NULL DEFAULT now(),

  UNIQUE (run_id, source_id, target_id, kind),
  -- A self-edge contributes nothing to a traversal and costs a wasted hop of
  -- the depth budget on every expansion that meets it.
  CHECK (source_id <> target_id)
);

-- Traversal runs in both directions: "what does this call" and "what calls this".
CREATE INDEX graph_edges_source_idx ON graph_edges (source_id, kind);
CREATE INDEX graph_edges_target_idx ON graph_edges (target_id, kind);

-- Also not in the contract, and also for a cascade. Deleting a run reaches its
-- edges through the unique index above, which leads with `run_id`; deleting a
-- repository has no such path and would scan every edge of every repository.
CREATE INDEX graph_edges_repository_idx ON graph_edges (repository_id);

-- migrate:down

DROP TABLE IF EXISTS graph_edges;
DROP TABLE IF EXISTS graph_nodes;
DROP TYPE IF EXISTS graph_edge_kind;
DROP TYPE IF EXISTS graph_node_kind;
