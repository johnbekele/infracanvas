---
title: '[db] Repository and ingestion run tables'
labels: tier:2, size:s, area:db, epic:1-data
---

### Epic

#2

### Context

Before any code can be parsed or embedded, the system needs to record which repository was ingested,
at which commit, and whether that run finished. Without the commit SHA there is no way to answer the
question that makes the whole pipeline trustworthy: is this analysis describing the code that is on
the branch right now, or code from three weeks ago?

Recording ingestion as a run with a terminal state also makes re-ingestion cheap. A run that failed
halfway can be discarded wholesale rather than leaving partially embedded files that quietly poison
retrieval.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TABLE repositories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  github_owner  text NOT NULL,
  github_name   text NOT NULL,
  default_branch text NOT NULL,
  is_private    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, github_owner, github_name)
);

CREATE TYPE ingestion_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE ingestion_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  commit_sha    text NOT NULL,
  ref           text NOT NULL,
  status        ingestion_status NOT NULL DEFAULT 'pending',
  error         text,
  files_total   integer NOT NULL DEFAULT 0,
  files_parsed  integer NOT NULL DEFAULT 0,
  chunks_written integer NOT NULL DEFAULT 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingestion_runs_repository_idx ON ingestion_runs (repository_id, created_at DESC);
-- At most one active run per repository. A partial unique index expresses this
-- without a trigger and without blocking historical rows.
CREATE UNIQUE INDEX ingestion_runs_one_active_idx
  ON ingestion_runs (repository_id)
  WHERE status IN ('pending', 'running');
```

```typescript
export interface Repository {
  id: string;
  userId: string;
  githubOwner: string;
  githubName: string;
  defaultBranch: string;
  isPrivate: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type IngestionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export function upsertRepository(input: UpsertRepositoryInput): Promise<Repository>;
export function listRepositories(userId: string): Promise<Repository[]>;
export function startIngestionRun(input: StartRunInput): Promise<IngestionRun>;
export function completeIngestionRun(runId: string, counts: RunCounts): Promise<IngestionRun>;
export function failIngestionRun(runId: string, error: string): Promise<IngestionRun>;
export function latestSucceededRun(repositoryId: string): Promise<IngestionRun | null>;
```

### Files

- CREATE `db/migrations/<timestamp>_repositories_and_ingestion.sql`
- CREATE `apps/api/src/lib/db/repositories.ts`
- CREATE `apps/api/src/lib/db/ingestion-runs.ts`
- CREATE `apps/api/src/lib/db/repositories.integration.test.ts`
- CREATE `apps/api/src/lib/db/ingestion-runs.integration.test.ts`

### Acceptance Criteria

- [ ] `upsertRepository` called twice for the same owner and name yields one row
- [ ] Two users may each register the same public repository without collision
- [ ] Starting a second run while one is `pending` or `running` raises a unique violation
- [ ] Starting a run after the previous one `succeeded` is permitted
- [ ] `completeIngestionRun` sets `finished_at` and the three count columns
- [ ] `latestSucceededRun` ignores failed and running rows
- [ ] Deleting a user removes their repositories and those repositories' runs

### Required Tests

- `upserts rather than duplicating a repository`
- `lets two users register the same public repository`
- `refuses a second concurrent run for one repository`
- `allows a new run once the previous one finished`
- `records counts and finished_at on completion`
- `records the error message on failure`
- `latestSucceededRun ignores runs that failed`
- `cascades deletion from user to repository to run`

### Performance Budget

n/a

### Out of Scope

- Do not add file, chunk, or embedding tables; those are the next issue
- Do not implement the ingestion process itself, only its bookkeeping
- Do not add HTTP routes

### Dependencies

Blocked by #22.

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
