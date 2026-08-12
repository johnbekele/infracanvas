/**
 * The shapes the job queue and its worker exchange.
 *
 * Kept apart from the SQL in `queue.ts` and the loop in `worker.ts` so that a
 * handler can be written, and typed, against the queue without importing either.
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * A job's arguments.
 *
 * A record rather than `unknown` because it is stored as `jsonb` and read back
 * by a handler that has to narrow it. Nothing secret belongs here: the row
 * outlives the run, so a credential in a payload is a credential at rest in a
 * table nobody thinks of as holding one. Handlers look up what they need from
 * the identifiers they are given.
 */
export type JobPayload = Record<string, unknown>;

export interface Job {
  id: string;
  kind: string;
  payload: JobPayload;
  status: JobStatus;
  /** Lower runs first. */
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  /** When the current lease lapses, after which another worker may claim it. */
  leasedUntil: Date | null;
  leaseOwner: string | null;
  lastError: string | null;
  /** The analysis this job runs, for the jobs that run one. */
  analysisId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueInput {
  kind: string;
  payload?: JobPayload;
  priority?: number;
  maxAttempts?: number;
  /** Earliest the job may run. Defaults to now. */
  runAt?: Date;
  analysisId?: string | null;
}

export type JobEventLevel = 'info' | 'warn' | 'error';

export interface NewJobEvent {
  level: JobEventLevel;
  message: string;
  /** 0 to 1, or null when the line reports no advance. */
  progress?: number | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  at: Date;
  level: JobEventLevel;
  message: string;
  progress: number | null;
}

export interface JobContext {
  readonly jobId: string;
  /** Aborted when the worker is stopping, so a handler can give up promptly. */
  readonly signal: AbortSignal;
  progress(fraction: number, message: string): Promise<void>;
  log(level: JobEventLevel, message: string): Promise<void>;
}

export interface JobHandler<P = JobPayload> {
  readonly kind: string;
  /** Long-running work. Call `ctx.progress` to report; check `ctx.signal` to stop promptly. */
  handle(payload: P, ctx: JobContext): Promise<void>;
  /**
   * Called once the job has failed for good, with no attempt left.
   *
   * Only the queue knows when that is -- the handler sees one attempt and cannot
   * tell whether it was the last. Without this hook, a row the handler owns is
   * left saying "running" forever after the third failure, and a user watches
   * progress that will never move.
   */
  onExhausted?(payload: P, error: string): Promise<void>;
}

/**
 * A failure no retry can fix.
 *
 * The queue's default is to retry, which is right when it cannot tell what went
 * wrong. A handler often can: a repository that has been disconnected will still
 * be disconnected in four seconds, and spending three attempts discovering that
 * only delays telling the user. Throwing this fails the job at once.
 */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

export interface WorkerOptions {
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
}
