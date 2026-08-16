-- migrate:up

-- One cluster of related symbols, as one ingestion pass partitioned the graph.
--
-- Keyed by run for the same reason `graph_nodes` is: a partition is only
-- meaningful against the node ids of the run that produced it, and a re-index
-- renumbers everything. Level 0 is the finest partition and each level above
-- aggregates the one below, so `parent_id` points at a coarser community and is
-- null only at the top.
CREATE TABLE graph_communities (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid        NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid        NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  level         smallint    NOT NULL,
  parent_id     uuid        REFERENCES graph_communities (id) ON DELETE CASCADE,
  -- Stable within (run, level): assigned in ascending order of the smallest
  -- member qualified_name, so an ordinal means the same thing across runs and a
  -- cached summary keyed by it survives a re-index of the same commit.
  ordinal       integer     NOT NULL,
  node_count    integer     NOT NULL,
  quality       real        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (run_id, level, ordinal),
  CHECK (level >= 0 AND node_count > 0)
);

CREATE INDEX graph_communities_repository_idx ON graph_communities (repository_id, level);

-- Not in the issue's contract, and added because the self-cascade needs it:
-- without an index on the referencing side, deleting one community makes
-- Postgres scan the whole table to find the children pointing at it.
CREATE INDEX graph_communities_parent_idx ON graph_communities (parent_id);

CREATE TABLE graph_community_members (
  community_id uuid NOT NULL REFERENCES graph_communities (id) ON DELETE CASCADE,
  node_id      uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,

  PRIMARY KEY (community_id, node_id)
);

-- Retrieval asks "which community is this node in", which is the reverse of
-- the primary key's order.
CREATE INDEX graph_community_members_node_idx ON graph_community_members (node_id);

-- migrate:down

DROP TABLE IF EXISTS graph_community_members;
DROP TABLE IF EXISTS graph_communities;
