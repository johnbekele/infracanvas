---
title: '[db] Experiment, deployment, and artifact tables'
labels: tier:2, size:m, area:db, epic:1-data
---

### Epic

#2

### Context

An experiment is the unit the product is named for: a proposed architecture, the infrastructure code
generated from it, what it cost to run, and what the load test measured. It is also the unit that
gets destroyed, so every AWS resource the platform creates has to be traceable back to one row.

Two requirements shape this schema.

**Nothing may be orphaned.** If a deployment row can exist without a recorded stack name and region,
then a failed destroy leaves resources running in someone's AWS account with no record of where. The
columns needed to destroy a stack are therefore not nullable.

**Every experiment has an expiry.** The guardrail that stops this platform generating surprise AWS
bills is a TTL that is set when the experiment is created, not one bolted on later. Storing
`expires_at` from the start means the sweeper can be written against data that already exists.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TYPE experiment_status AS ENUM (
  'draft', 'analysing', 'ready', 'deploying', 'deployed', 'testing', 'destroying', 'destroyed', 'failed'
);

CREATE TABLE experiments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  repository_id uuid REFERENCES repositories (id) ON DELETE SET NULL,
  name          text NOT NULL,
  status        experiment_status NOT NULL DEFAULT 'draft',
  -- The architecture IR document. Validated against packages/ir-schema.
  ir            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ir_version    text NOT NULL,
  -- Guardrails, set at creation so the sweeper can rely on them.
  expires_at    timestamptz NOT NULL,
  budget_usd    numeric(10, 2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (budget_usd > 0)
);

CREATE INDEX experiments_user_idx ON experiments (user_id, created_at DESC);
-- Drives the TTL sweeper.
CREATE INDEX experiments_expiry_idx ON experiments (expires_at)
  WHERE status NOT IN ('destroyed', 'failed', 'draft');

CREATE TABLE deployments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  -- Not nullable: without these a stack cannot be destroyed.
  aws_account_id text NOT NULL,
  aws_region     text NOT NULL,
  stack_name     text NOT NULL,
  status         text NOT NULL,
  codebuild_build_id text,
  outputs        jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_monthly_usd numeric(10, 2),
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE artifact_kind AS ENUM (
  'pulumi_program', 'workflow', 'cost_report', 'latency_report', 'loadtest_report', 'patch'
);

CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  kind          artifact_kind NOT NULL,
  path          text NOT NULL,
  content       text NOT NULL,
  content_sha256 text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, kind, path)
);
```

```typescript
export function createExperiment(input: CreateExperimentInput): Promise<Experiment>;
export function setExperimentStatus(id: string, status: ExperimentStatus): Promise<Experiment>;
export function listExpiredExperiments(now: Date): Promise<Experiment[]>;
export function recordDeployment(input: RecordDeploymentInput): Promise<Deployment>;
export function putArtifact(input: PutArtifactInput): Promise<Artifact>;
export function listArtifacts(experimentId: string, kind?: ArtifactKind): Promise<Artifact[]>;
```

### Files

- CREATE `db/migrations/<timestamp>_experiments.sql`
- CREATE `apps/api/src/lib/db/experiments.ts`
- CREATE `apps/api/src/lib/db/artifacts.ts`
- CREATE `apps/api/src/lib/db/experiments.integration.test.ts`
- CREATE `apps/api/src/lib/db/artifacts.integration.test.ts`

### Acceptance Criteria

- [ ] An experiment cannot be created with a zero or negative budget
- [ ] An experiment cannot be created without `expires_at`
- [ ] `listExpiredExperiments` returns experiments past their expiry that are not destroyed, failed, or draft
- [ ] `listExpiredExperiments` excludes drafts, which have never provisioned anything
- [ ] Deleting the source repository leaves the experiment intact with a null `repository_id`
- [ ] Deleting a user removes their experiments, deployments, and artifacts
- [ ] `putArtifact` for an existing kind and path replaces rather than duplicating
- [ ] A deployment cannot be recorded without account, region, and stack name

### Required Tests

- `rejects a non positive budget`
- `rejects an experiment with no expiry`
- `lists experiments past their expiry`
- `excludes drafts from the expiry sweep`
- `excludes already destroyed experiments from the expiry sweep`
- `keeps the experiment when its source repository is deleted`
- `cascades deletion from user to experiment to deployment and artifact`
- `replaces an artifact of the same kind and path`
- `rejects a deployment missing the fields needed to destroy it`

### Performance Budget

`listExpiredExperiments` runs in under 20ms with 100k experiment rows, using the partial index rather
than a sequential scan.

### Out of Scope

- Do not implement the TTL sweeper itself; this issue provides the query it will use
- Do not validate the `ir` column against the IR schema here; that lands with the IR epic
- Do not add AWS connection or credential tables; those are tier 1 and tracked in the deploy epic

### Dependencies

Blocked by #24.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm --filter @infracanvas/api test:integration
psql "$DATABASE_URL" -c "EXPLAIN SELECT * FROM experiments WHERE expires_at < now() AND status NOT IN ('destroyed','failed','draft')"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
