/**
 * The loop that runs queued jobs.
 *
 * Deliberately not an event bus. A worker that hears about a job over a channel
 * has to be listening at the moment the job is created, which makes a restart a
 * lost job; polling a table asks a question whose answer does not depend on when
 * it was asked. The cost is up to `pollIntervalMs` of latency on an idle queue,
 * paid once per job, on work that takes tens of seconds.
 *
 * The unusual part is that failing is not the same as crashing. A handler that
 * throws has failed this attempt and the queue decides whether to retry it; a
 * worker that is stopping has not failed anything, so the job goes back with its
 * lease released and no error recorded. Conflating the two either retries work
 * that will never succeed or discards work that would have.
 */
import { randomUUID } from 'node:crypto';
import { logError, logWarn } from '../log.js';
import * as queue from './queue.js';
import { createJobContext } from './context.js';
import { NonRetryableJobError } from './types.js';
import type { Job, JobHandler, JobPayload, WorkerOptions } from './types.js';

const DEFAULTS: WorkerOptions = {
  concurrency: 2,
  pollIntervalMs: 1_000,
  // Long enough that a slow GitHub call is not mistaken for a dead worker, short
  // enough that a genuinely dead one's work is not stranded for minutes. The
  // heartbeat renews it every few seconds regardless of how long the job takes.
  leaseMs: 30_000,
  heartbeatMs: 5_000,
};

export class Worker {
  private readonly handlers = new Map<string, JobHandler<JobPayload>>();
  private readonly options: WorkerOptions;
  private readonly owner: string;
  private readonly running = new Map<string, AbortController>();
  private stopping = false;
  private loop: Promise<void> | null = null;

  constructor(options: Partial<WorkerOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    // Identifies this worker in `lease_owner`, so an operator looking at a stuck
    // job can tell which process is holding it.
    this.owner = `${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  register<P>(handler: JobHandler<P>): this {
    this.handlers.set(handler.kind, handler as JobHandler<JobPayload>);
    return this;
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  /** Stop claiming, ask running jobs to give up, and wait for them to return. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.running.values()) controller.abort();

    const loop = this.loop;
    this.loop = null;
    if (loop) await loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let claimed = 0;

      try {
        claimed = await this.tick();
      } catch (error) {
        // A failure to reach the database must not end the loop, or one blip
        // silently stops all background work until someone restarts the process.
        logError('Job queue poll failed', error);
      }

      // Only pause when there was nothing to do. A backlog drains at the speed of
      // the work rather than the poll interval.
      if (claimed === 0) await this.sleep(this.options.pollIntervalMs);
    }

    while (this.running.size > 0) await this.sleep(25);
  }

  private async tick(): Promise<number> {
    const capacity = this.options.concurrency - this.running.size;
    if (capacity <= 0) return 0;

    const retired = await queue.expireStranded();
    for (const job of retired) {
      logWarn('Retired a job abandoned by a stopped worker', { jobId: job.id, kind: job.kind });
      await queue.appendEvent(job.id, {
        level: 'error',
        message: job.lastError ?? 'The worker running this job stopped without reporting.',
      });
      await this.notifyExhausted(job, job.lastError ?? 'The worker running this job stopped.');
    }

    const jobs = await queue.claim(
      this.owner,
      [...this.handlers.keys()],
      capacity,
      this.options.leaseMs
    );

    for (const job of jobs) {
      const controller = new AbortController();
      this.running.set(job.id, controller);
      void this.execute(job, controller);
    }

    return jobs.length;
  }

  private async execute(job: Job, controller: AbortController): Promise<void> {
    const handler = this.handlers.get(job.kind);
    const heart = setInterval(() => {
      void this.renew(job.id, controller);
    }, this.options.heartbeatMs);

    try {
      if (!handler) throw new Error(`No handler registered for job kind '${job.kind}'`);

      await handler.handle(job.payload, createJobContext(job.id, controller.signal));
      await queue.complete(job.id, this.owner);
      await queue.appendEvent(job.id, { level: 'info', message: 'Finished.', progress: 1 });
    } catch (error) {
      await this.recordFailure(job, error);
    } finally {
      clearInterval(heart);
      this.running.delete(job.id);
    }
  }

  /**
   * Give the job back, or fail it.
   *
   * A worker that is stopping did not learn anything about whether this job can
   * succeed, so it releases the lease and leaves the attempt to the next worker
   * rather than spending one of the job's retries on its own shutdown.
   */
  private async recordFailure(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    try {
      if (this.stopping) {
        await queue.heartbeat(job.id, this.owner, 0);
        await queue.appendEvent(job.id, {
          level: 'warn',
          message: 'The worker stopped. This run will be retried.',
        });
        return;
      }

      if (error instanceof NonRetryableJobError) {
        await queue.discard(job.id, this.owner, message);
        await queue.appendEvent(job.id, { level: 'error', message });
        await this.notifyExhausted(job, message);
        return;
      }

      const after = await queue.fail(job.id, this.owner, message);
      const done = after.status === 'failed';
      await queue.appendEvent(job.id, {
        level: done ? 'error' : 'warn',
        message: done ? message : `${message} Retrying (attempt ${after.attempts + 1}).`,
      });
      if (done) await this.notifyExhausted(job, message);
    } catch (bookkeeping) {
      // The job failed and recording that failed too. Losing the log here would
      // leave a job in `running` with no explanation anywhere.
      logError('Failed to record job failure', {
        jobId: job.id,
        original: message,
        cause: bookkeeping,
      });
    }
  }

  /**
   * Tell the handler its job is over, so it can settle whatever it owns.
   *
   * Its own failure is logged rather than raised: the job is already failed, and
   * there is nothing further to report it to.
   */
  private async notifyExhausted(job: Job, message: string): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler?.onExhausted) return;

    try {
      await handler.onExhausted(job.payload, message);
    } catch (error) {
      logError('Failed to settle an exhausted job', { jobId: job.id, cause: error });
    }
  }

  private async renew(jobId: string, controller: AbortController): Promise<void> {
    try {
      const held = await queue.heartbeat(jobId, this.owner, this.options.leaseMs);
      // Someone else owns it now, which means this process was considered dead.
      // Continuing would run the job twice over.
      if (!held) {
        logWarn('Lost job lease, abandoning run', { jobId });
        controller.abort();
      }
    } catch (error) {
      logError('Failed to renew job lease', { jobId, cause: error });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Do not hold the process open waiting to poll a queue nobody is reading.
      timer.unref?.();
    });
  }
}
