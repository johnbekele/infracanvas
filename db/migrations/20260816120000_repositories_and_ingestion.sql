-- migrate:up

-- The `repositories` table this issue also specified already landed in
-- 20260810120000_repositories.sql, with a `github_id` column the spec predates.
-- Recreating it here would drop that column, so only the ingestion side is new.

CREATE TYPE ingestion_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- One pass of the engine over a repository: walk, parse, chunk, embed, index.
--
-- Modelled as a run with a terminal state rather than as a flag on the
-- repository, because a run that dies halfway has to be discardable as a unit.
-- Partially embedded files left behind by a half-finished pass do not announce
-- themselves; they quietly degrade retrieval for every later query.
CREATE TABLE ingestion_runs (
  id             uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id  uuid             NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  -- Not nullable, unlike the equivalent on `analyses`: a run is only started
  -- once its ref has been resolved. Without the exact commit there is no way to
  -- tell whether an index describes the branch as it is now or as it was weeks
  -- ago, and an index that cannot be dated cannot be trusted or invalidated.
  commit_sha     text             NOT NULL,
  ref            text             NOT NULL,
  status         ingestion_status NOT NULL DEFAULT 'pending',
  error          text,
  files_total    integer          NOT NULL DEFAULT 0,
  files_parsed   integer          NOT NULL DEFAULT 0,
  chunks_written integer          NOT NULL DEFAULT 0,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz      NOT NULL DEFAULT now(),
  updated_at     timestamptz      NOT NULL DEFAULT now()
);

CREATE INDEX ingestion_runs_repository_idx ON ingestion_runs (repository_id, created_at DESC);

-- At most one active run per repository. A partial unique index expresses this
-- without a trigger and without blocking historical rows.
CREATE UNIQUE INDEX ingestion_runs_one_active_idx
  ON ingestion_runs (repository_id)
  WHERE status IN ('pending', 'running');

CREATE TRIGGER ingestion_runs_set_updated_at
  BEFORE UPDATE ON ingestion_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TABLE IF EXISTS ingestion_runs;
DROP TYPE IF EXISTS ingestion_status;
