/**
 * The durable job queue.
 *
 * Every state transition is one statement. A claim that read the candidates and
 * then updated them would let two workers pick the same job in the window
 * between; `SELECT ... FOR UPDATE SKIP LOCKED` inside the `UPDATE` closes that
 * window in the database rather than in a lock this process would have to hold.
 *
 * Ownership is part of every predicate for the same reason. `complete` and `fail`
 * match on `lease_owner`, so a worker that has been superseded -- its lease
 * lapsed, another worker took the job -- cannot report on work it no longer owns
 * and overwrite the result of the worker that does.
 */
import { query } from '../db/client.js';
import type { EnqueueInput, Job, JobEvent, JobEventLevel, NewJobEvent } from './types.js';

interface JobRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: Job['status'];
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  leased_until: Date | null;
  lease_owner: string | null;
  last_error: string | null;
  analysis_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface JobEventRow {
  id: string;
  job_id: string;
  at: Date;
  level: JobEventLevel;
  message: string;
  progress: number | null;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    leasedUntil: row.leased_until,
    leaseOwner: row.lease_owner,
    lastError: row.last_error,
    analysisId: row.analysis_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toJobEvent(row: JobEventRow): JobEvent {
  return {
    // `bigserial` arrives as a string, because a bigint does not fit a JS number
    // in general. These ids do, and the client compares them numerically.
    id: Number(row.id),
    jobId: row.job_id,
    at: row.at,
    level: row.level,
    message: row.message,
    progress: row.progress,
  };
}

export async function enqueue(input: EnqueueInput): Promise<Job> {
  const result = await query<JobRow>(
    `INSERT INTO jobs (kind, payload, priority, max_attempts, run_at, analysis_id)
     VALUES ($1, $2, COALESCE($3, 100), COALESCE($4, 3), COALESCE($5, now()), $6)
     RETURNING *`,
    [
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? null,
      input.maxAttempts ?? null,
      input.runAt ?? null,
      input.analysisId ?? null,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to enqueue job');
  return toJob(row);
}

/**
 * Atomically claim up to `limit` due jobs, taking a lease for `leaseMs`.
 *
 * A job whose lease has lapsed is claimable again, which is how work survives a
 * worker that died holding it. `attempts < max_attempts` guards the increment
 * against the `attempts <= max_attempts` constraint: a job that crashed on its
 * final attempt has no attempt left to take, and is retired by
 * `expireStranded` rather than reclaimed here.
 */
export async function claim(
  owner: string,
  kinds: readonly string[],
  limit: number,
  leaseMs: number
): Promise<Job[]> {
  if (kinds.length === 0 || limit <= 0) return [];

  const result = await query<JobRow>(
    `UPDATE jobs SET status = 'running',
            attempts = attempts + 1,
            leased_until = now() + make_interval(secs => $4 / 1000.0),
            lease_owner = $1
      WHERE id IN (
        SELECT id FROM jobs
         WHERE kind = ANY($2::text[]) AND run_at <= now()
           AND attempts < max_attempts
           AND (status = 'queued' OR (status = 'running' AND leased_until < now()))
         ORDER BY priority, run_at
         FOR UPDATE SKIP LOCKED
         LIMIT $3
      )
      RETURNING *`,
    [owner, [...kinds], limit, leaseMs]
  );

  return result.rows.map(toJob);
}

/** Extend the lease. False when the caller is not the holder, having changed nothing. */
export async function heartbeat(jobId: string, owner: string, leaseMs: number): Promise<boolean> {
  const result = await query(
    `UPDATE jobs
        SET leased_until = now() + make_interval(secs => $3 / 1000.0)
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [jobId, owner, leaseMs]
  );

  return (result.rowCount ?? 0) > 0;
}

/** Mark the job done. A caller that does not hold the lease changes nothing. */
export async function complete(jobId: string, owner: string): Promise<void> {
  await query(
    `UPDATE jobs
        SET status = 'succeeded', leased_until = NULL, lease_owner = NULL
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [jobId, owner]
  );
}

/**
 * Requeue with backoff, or mark failed once `max_attempts` is reached.
 *
 * The delay doubles with each attempt and is capped at five minutes: a failure
 * caused by something transient clears on the first retry, and one caused by
 * something that is down stops hammering it. The decision is made in SQL from
 * the row's own `attempts`, so two workers cannot read the same count and both
 * conclude there is a retry left.
 */
export async function fail(jobId: string, owner: string, error: string): Promise<Job> {
  const result = await query<JobRow>(
    `UPDATE jobs
        SET status = CASE
              WHEN attempts >= max_attempts THEN 'failed'::job_status
              ELSE 'queued'::job_status
            END,
            run_at = CASE
              WHEN attempts >= max_attempts THEN run_at
              ELSE now() + make_interval(secs => least(power(2, attempts)::int, 300))
            END,
            last_error = $3,
            leased_until = NULL,
            lease_owner = NULL
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
      RETURNING *`,
    [jobId, owner, error]
  );

  const row = result.rows[0];
  if (row) return toJob(row);

  // Not the lease holder, or the job already left `running`. The current row is
  // the honest answer: nothing was changed, and the caller should see why.
  const current = await findJob(jobId);
  if (!current) throw new Error('Job not found');
  return current;
}

/** Fail a job outright, for a failure that no retry could fix. */
export async function discard(jobId: string, owner: string, error: string): Promise<void> {
  await query(
    `UPDATE jobs
        SET status = 'failed', last_error = $3, leased_until = NULL, lease_owner = NULL
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [jobId, owner, error]
  );
}

/**
 * Retire jobs that crashed on their final attempt.
 *
 * `claim` cannot reclaim these without exceeding `max_attempts`, so without this
 * they would sit in `running` with a lapsed lease forever, and an analysis behind
 * one would show progress that never finishes.
 *
 * Returns the rows it retired so the caller can settle whatever each job owned.
 */
export async function expireStranded(): Promise<Job[]> {
  const result = await query<JobRow>(
    `UPDATE jobs
        SET status = 'failed',
            last_error = COALESCE(last_error, 'The worker running this job stopped without reporting.'),
            leased_until = NULL,
            lease_owner = NULL
      WHERE status = 'running' AND leased_until < now() AND attempts >= max_attempts
      RETURNING *`
  );

  return result.rows.map(toJob);
}

export async function findJob(id: string): Promise<Job | null> {
  const result = await query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

/** The most recent job created for an analysis, retries and all. */
export async function findJobForAnalysis(analysisId: string): Promise<Job | null> {
  const result = await query<JobRow>(
    'SELECT * FROM jobs WHERE analysis_id = $1 ORDER BY created_at DESC LIMIT 1',
    [analysisId]
  );
  return result.rows[0] ? toJob(result.rows[0]) : null;
}

export async function appendEvent(jobId: string, event: NewJobEvent): Promise<void> {
  await query(`INSERT INTO job_events (job_id, level, message, progress) VALUES ($1, $2, $3, $4)`, [
    jobId,
    event.level,
    event.message,
    event.progress ?? null,
  ]);
}

/**
 * Events for a job, oldest first.
 *
 * `afterId` is what makes a reconnect cheap: a client that dropped mid-run
 * resumes from the last id it saw instead of replaying the whole log.
 */
export async function readEvents(jobId: string, afterId?: number): Promise<JobEvent[]> {
  const result = await query<JobEventRow>(
    `SELECT * FROM job_events
      WHERE job_id = $1 AND ($2::bigint IS NULL OR id > $2::bigint)
      ORDER BY id`,
    [jobId, afterId ?? null]
  );

  return result.rows.map(toJobEvent);
}
