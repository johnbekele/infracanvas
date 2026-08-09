---
title: '[db] Durable job queue with SELECT FOR UPDATE SKIP LOCKED'
labels: tier:2, size:m, area:db, epic:1-data
---

### Epic

#2

### Context

Ingesting a repository, generating code, and running a load test all take minutes. None of them can
run inside an HTTP request, and none may be lost when a process restarts mid-flight.

The queue lives in Postgres rather than Redis or SQS for the same reason the vectors do: a
self-hosted install should need one service, not three. The cost is throughput, and it is not a real
cost here. `SELECT FOR UPDATE SKIP LOCKED` sustains thousands of jobs per second, while this
workload measures in jobs per minute.

What matters far more than throughput is that a job survives a crash. A worker that dies holding a
job must not strand it forever, so leases expire and expired jobs return to the queue. That single
property is what makes the difference between a queue and a list of intentions.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        job_status NOT NULL DEFAULT 'queued',
  priority      integer NOT NULL DEFAULT 100,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 3,
  run_at        timestamptz NOT NULL DEFAULT now(),
  -- Held by a worker until this instant. A crashed worker's job becomes
  -- claimable again once it passes, which is what stops a crash stranding work.
  leased_until  timestamptz,
  lease_owner   text,
  last_error    text,
  experiment_id uuid REFERENCES experiments (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= max_attempts)
);

-- The claim query's exact predicate, so claiming never degrades to a scan.
CREATE INDEX jobs_claimable_idx ON jobs (priority, run_at)
  WHERE status IN ('queued', 'running');

CREATE TABLE job_events (
  id         bigserial PRIMARY KEY,
  job_id     uuid NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  level      text NOT NULL,
  message    text NOT NULL,
  progress   real
);

CREATE INDEX job_events_job_idx ON job_events (job_id, id);
```

```typescript
export function enqueue(input: EnqueueInput): Promise<Job>;
/** Atomically claim up to `limit` due jobs, taking a lease for `leaseMs`. */
export function claim(
  owner: string,
  kinds: readonly string[],
  limit: number,
  leaseMs: number
): Promise<Job[]>;
export function heartbeat(jobId: string, owner: string, leaseMs: number): Promise<boolean>;
export function complete(jobId: string, owner: string): Promise<void>;
/** Requeue with backoff, or mark failed once max_attempts is reached. */
export function fail(jobId: string, owner: string, error: string): Promise<Job>;
export function appendEvent(jobId: string, event: NewJobEvent): Promise<void>;
export function readEvents(jobId: string, afterId?: number): Promise<JobEvent[]>;
```

The claim query must be a single statement of the form:

```sql
UPDATE jobs SET status = 'running', attempts = attempts + 1,
       leased_until = now() + $leaseInterval, lease_owner = $owner
WHERE id IN (
  SELECT id FROM jobs
  WHERE kind = ANY($kinds) AND run_at <= now()
    AND (status = 'queued' OR (status = 'running' AND leased_until < now()))
  ORDER BY priority, run_at
  FOR UPDATE SKIP LOCKED
  LIMIT $limit
)
RETURNING *;
```

### Files

- CREATE `db/migrations/<timestamp>_job_queue.sql`
- CREATE `apps/api/src/lib/jobs/queue.ts`
- CREATE `apps/api/src/lib/jobs/types.ts`
- CREATE `apps/api/src/lib/jobs/queue.integration.test.ts`

### Acceptance Criteria

- [ ] Two workers claiming concurrently never receive the same job
- [ ] A job whose lease has expired is reclaimable by another worker
- [ ] `heartbeat` from the lease holder extends the lease; from anyone else it returns false and changes nothing
- [ ] `complete` from a worker that does not hold the lease does not mark the job succeeded
- [ ] `fail` requeues with a later `run_at` until `max_attempts`, then marks the job failed
- [ ] A job with `run_at` in the future is not claimed
- [ ] Jobs are claimed in priority order, then oldest first
- [ ] `readEvents` with `afterId` returns only newer events, so a reconnecting stream does not replay

### Required Tests

- `two workers never claim the same job`
- `reclaims a job whose lease expired`
- `heartbeat from the lease holder extends the lease`
- `heartbeat from a stranger is refused`
- `complete from a stranger is refused`
- `requeues with backoff until max attempts`
- `marks the job failed on the final attempt`
- `does not claim a job scheduled for the future`
- `claims in priority then age order`
- `readEvents after an id does not replay earlier events`

### Performance Budget

Claiming a single job from a table of 100k queued rows completes in under 10ms, using
`jobs_claimable_idx`.

### Out of Scope

- Do not implement the worker loop or any specific job handler; that is the next issue
- Do not add SSE routes here
- Do not introduce Redis, BullMQ, or any external queue
- Do not use `LISTEN`/`NOTIFY` as the claim mechanism; polling with backoff is sufficient and does
  not lose work when a listener is disconnected

### Dependencies

Blocked by #27.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm --filter @infracanvas/api test:integration
psql "$DATABASE_URL" -c "EXPLAIN SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY priority, run_at LIMIT 1"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
