-- migrate:up

CREATE TYPE analysis_status AS ENUM ('pending', 'running', 'succeeded', 'failed');

-- One run of the deterministic profiler over a repository.
--
-- Stored as a run with a terminal state rather than as a bare result, so a
-- failure is a recorded outcome the user can see and retry rather than a
-- request that silently returned nothing.
CREATE TABLE analyses (
  id            uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid            NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  ref           text            NOT NULL,
  -- Null until the ref has been resolved. Recording the exact commit is what
  -- makes a profile falsifiable: without it there is no way to tell whether the
  -- analysis describes the branch as it is now or as it was last month.
  commit_sha    text,
  status        analysis_status NOT NULL DEFAULT 'pending',
  -- The AppProfile, shaped by packages/core. Held as jsonb rather than spread
  -- across columns because it is read as a whole document and its schema is
  -- versioned inside the payload.
  profile       jsonb,
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz     NOT NULL DEFAULT now(),
  updated_at    timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX analyses_repository_idx ON analyses (repository_id, created_at DESC);

-- At most one analysis in flight per repository. A partial unique index states
-- this without a trigger and without constraining the historical rows.
CREATE UNIQUE INDEX analyses_one_active_idx
  ON analyses (repository_id)
  WHERE status IN ('pending', 'running');

CREATE TRIGGER analyses_set_updated_at
  BEFORE UPDATE ON analyses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TABLE IF EXISTS analyses;
DROP TYPE IF EXISTS analysis_status;
