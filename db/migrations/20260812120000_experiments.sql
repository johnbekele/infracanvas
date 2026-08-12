-- migrate:up

CREATE TYPE experiment_status AS ENUM (
  'draft', 'analysing', 'ready', 'deploying', 'deployed', 'testing', 'destroying', 'destroyed', 'failed'
);

-- One proposed architecture, the code generated from it, what it cost, and what
-- the load test measured.
--
-- This is also the unit that gets destroyed, so every AWS resource the platform
-- creates has to be traceable back to one of these rows.
CREATE TABLE experiments (
  id            uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid              NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Nullable, and SET NULL rather than CASCADE: disconnecting a repository must
  -- not silently destroy the record of what was deployed from it, because that
  -- record is how a running stack is found again.
  repository_id uuid              REFERENCES repositories (id) ON DELETE SET NULL,
  name          text              NOT NULL,
  status        experiment_status NOT NULL DEFAULT 'draft',
  -- The architecture IR document. Validated against packages/ir-schema by the
  -- application; a CHECK cannot run the reference rules that validator applies.
  ir            jsonb             NOT NULL DEFAULT '{}'::jsonb,
  ir_version    text              NOT NULL,
  -- Guardrails, set at creation rather than bolted on later, so the TTL sweeper
  -- can be written against data that already exists rather than against data it
  -- has to backfill first.
  expires_at    timestamptz       NOT NULL,
  budget_usd    numeric(10, 2)    NOT NULL,
  created_at    timestamptz       NOT NULL DEFAULT now(),
  updated_at    timestamptz       NOT NULL DEFAULT now(),
  -- A zero budget is not "no limit", it is a limit nothing can satisfy, and a
  -- negative one would make the sweeper's comparison meaningless.
  CONSTRAINT experiments_budget_ck CHECK (budget_usd > 0)
);

CREATE INDEX experiments_user_idx ON experiments (user_id, created_at DESC);

-- Drives the TTL sweeper. Partial because the sweep only cares about
-- experiments that may still be holding AWS resources: a draft never
-- provisioned anything, and a destroyed or failed one has nothing left to
-- reclaim.
CREATE INDEX experiments_expiry_idx ON experiments (expires_at)
  WHERE status NOT IN ('destroyed', 'failed', 'draft');

CREATE TRIGGER experiments_set_updated_at
  BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One attempt at putting an experiment's architecture into an AWS account.
CREATE TABLE deployments (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid           NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  -- Not nullable. Without an account, a region and a stack name there is no way
  -- to destroy what this row describes, and a deployment that cannot be
  -- destroyed is a bill nobody can stop.
  aws_account_id text          NOT NULL,
  aws_region     text          NOT NULL,
  stack_name     text          NOT NULL,
  status         text          NOT NULL,
  codebuild_build_id text,
  outputs        jsonb         NOT NULL DEFAULT '{}'::jsonb,
  estimated_monthly_usd numeric(10, 2),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX deployments_experiment_idx ON deployments (experiment_id, created_at DESC);

CREATE TRIGGER deployments_set_updated_at
  BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TYPE artifact_kind AS ENUM (
  'pulumi_program', 'workflow', 'cost_report', 'latency_report', 'loadtest_report', 'patch'
);

-- Everything the platform generated for an experiment: the infrastructure
-- program, the workflow that deploys it, and the reports produced about it.
CREATE TABLE artifacts (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid          NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  kind          artifact_kind NOT NULL,
  path          text          NOT NULL,
  content       text          NOT NULL,
  content_sha256 text         NOT NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  -- Regenerating a program for the same experiment replaces it rather than
  -- appending a second copy, so there is never a question of which generated
  -- file is the one that would be deployed.
  UNIQUE (experiment_id, kind, path)
);

-- migrate:down

DROP TABLE IF EXISTS artifacts;
DROP TYPE IF EXISTS artifact_kind;
DROP TABLE IF EXISTS deployments;
DROP TABLE IF EXISTS experiments;
DROP TYPE IF EXISTS experiment_status;
