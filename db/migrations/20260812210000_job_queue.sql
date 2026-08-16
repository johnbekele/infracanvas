-- migrate:up

CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- Work that cannot run inside an HTTP request.
--
-- The queue lives in Postgres rather than Redis or SQS for the same reason the
-- vectors will: a self-hosted install should need one service, not three. The
-- cost is throughput, and it is not a real cost here. `SELECT FOR UPDATE SKIP
-- LOCKED` sustains thousands of jobs per second while this workload measures in
-- jobs per minute.
--
-- What matters far more than throughput is that a job survives a crash, which is
-- what `leased_until` is for: a worker that dies holding a job stops renewing the
-- lease, and once it lapses another worker may claim the job. Without that, a
-- crash strands work forever and this is a list of intentions rather than a
-- queue.
CREATE TABLE jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status        job_status  NOT NULL DEFAULT 'queued',
  priority      integer     NOT NULL DEFAULT 100,
  attempts      integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 3,
  run_at        timestamptz NOT NULL DEFAULT now(),
  -- Held by a worker until this instant. A crashed worker's job becomes
  -- claimable again once it passes, which is what stops a crash stranding work.
  leased_until  timestamptz,
  lease_owner   text,
  last_error    text,
  -- The analysis this job runs, when it runs one. The spec for this table names
  -- an `experiment_id` instead, but `experiments` does not exist yet (#27), and a
  -- foreign key to a missing table will not create. This is the same idea for the
  -- work the queue actually has: it cascades, and it gives the progress stream an
  -- indexed way to find the job behind an analysis. #27 can add `experiment_id`
  -- beside it without touching anything here.
  analysis_id   uuid        REFERENCES analyses (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= max_attempts)
);

-- The claim query's exact predicate, so claiming never degrades to a scan.
CREATE INDEX jobs_claimable_idx ON jobs (priority, run_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX jobs_analysis_idx ON jobs (analysis_id) WHERE analysis_id IS NOT NULL;

CREATE TRIGGER jobs_set_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What a job reported while it ran.
--
-- A monotonic `bigserial` rather than a timestamp, because the id is what a
-- reconnecting stream resumes from: two events written in the same millisecond
-- have an unambiguous order, and `Last-Event-ID` is a cursor rather than a clock.
CREATE TABLE job_events (
  id       bigserial   PRIMARY KEY,
  job_id   uuid        NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  level    text        NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message  text        NOT NULL,
  -- 0 to 1, or null for a log line that reports no advance.
  progress real        CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1))
);

CREATE INDEX job_events_job_idx ON job_events (job_id, id);

-- migrate:down

DROP TABLE IF EXISTS job_events;
DROP TABLE IF EXISTS jobs;
DROP TYPE IF EXISTS job_status;
