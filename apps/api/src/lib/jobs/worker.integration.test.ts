/**
 * What the worker does with a handler that succeeds, fails, or hangs.
 *
 * Driven by starting a real worker against a real queue rather than by calling
 * `execute` directly, because the behaviour under test is the interaction between
 * the loop, the lease and the retry rules -- and that interaction is the part
 * that would still be wrong after every unit of it passed in isolation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../db/client.js';
import { claim, enqueue, findJob, readEvents } from './queue.js';
import { Worker } from './worker.js';
import { NonRetryableJobError, type JobContext, type JobPayload } from './types.js';

const KIND = 'test.worker.job';

const workers: Worker[] = [];

function startWorker(
  handle: (payload: JobPayload, ctx: JobContext) => Promise<void>,
  onExhausted?: (payload: JobPayload, error: string) => Promise<void>
): Worker {
  const worker = new Worker({
    concurrency: 1,
    pollIntervalMs: 10,
    leaseMs: 2_000,
    heartbeatMs: 500,
  });

  worker.register({ kind: KIND, handle, onExhausted });
  worker.start();
  workers.push(worker);
  return worker;
}

/** Wait for a condition the worker is expected to bring about. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error('Timed out waiting for the worker');
}

const statusOf = async (jobId: string) => (await findJob(jobId))!.status;

beforeEach(async () => {
  await query('TRUNCATE users, jobs CASCADE');
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

afterAll(async () => {
  await closePool();
});

describe('Worker', () => {
  it('runs a handler for a matching job kind', async () => {
    const job = await enqueue({ kind: KIND, payload: { label: 'work' } });

    startWorker(async (payload, ctx) => {
      expect(payload.label).toBe('work');
      await ctx.progress(0.5, 'Halfway.');
    });

    await eventually(async () => (await statusOf(job.id)) === 'succeeded');

    const events = await readEvents(job.id);
    expect(events.map((event) => event.message)).toEqual(['Halfway.', 'Finished.']);
    // The closing event reports completion, so a client that only watches
    // progress still sees the bar reach the end.
    expect(events.at(-1)!.progress).toBe(1);
  });

  it('never exceeds the configured concurrency', async () => {
    for (let i = 0; i < 6; i += 1) await enqueue({ kind: KIND });

    let inFlight = 0;
    let peak = 0;
    let finished = 0;

    const worker = new Worker({
      concurrency: 2,
      pollIntervalMs: 10,
      leaseMs: 5_000,
      heartbeatMs: 1_000,
    });
    worker.register({
      kind: KIND,
      handle: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        finished += 1;
      },
    });
    worker.start();
    workers.push(worker);

    await eventually(async () => finished === 6);

    // The limit exists because each analysis is dozens of GitHub requests against
    // one user's rate limit: exceeding it converts throughput into 429s.
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('extends the lease while the handler is still running', async () => {
    // A lease shorter than the work, so the job would be reclaimed from under the
    // handler if nothing renewed it.
    const job = await enqueue({ kind: KIND });
    let done = false;

    const worker = new Worker({
      concurrency: 1,
      pollIntervalMs: 10,
      leaseMs: 300,
      heartbeatMs: 50,
    });
    worker.register({
      kind: KIND,
      handle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        done = true;
      },
    });
    worker.start();
    workers.push(worker);

    await eventually(async () => (await statusOf(job.id)) === 'running');

    // Held throughout: another worker must never be able to take a job that is
    // still being worked on, or the same analysis runs twice.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await claim('another-worker', [KIND], 1, 30_000)).toEqual([]);
    }

    await eventually(async () => done && (await statusOf(job.id)) === 'succeeded');
    expect((await findJob(job.id))!.attempts).toBe(1);
  });

  it('retries a failing handler until max attempts', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 3 });
    let attempts = 0;

    startWorker(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('Transient trouble');
    });

    await eventually(async () => (await statusOf(job.id)) === 'succeeded');

    expect(attempts).toBe(2);
    // The user watching should see why it paused, not a stall with no
    // explanation followed by a sudden success.
    const messages = (await readEvents(job.id)).map((event) => event.message);
    expect(messages.some((message) => message.includes('Transient trouble'))).toBe(true);
  });

  it('marks the job failed and records the error when the handler throws', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 2 });
    const exhausted: string[] = [];

    startWorker(
      async () => {
        throw new Error('Always broken');
      },
      async (_payload, error) => {
        exhausted.push(error);
      }
    );

    // Waits for the callback rather than the status, because the row reaches
    // `failed` a moment before the handler is told about it.
    await eventually(async () => exhausted.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Settled exactly once. Called per attempt, a handler would mark its own
    // domain row failed while the queue was still retrying.
    expect(exhausted).toEqual(['Always broken']);
    expect(await statusOf(job.id)).toBe('failed');
    expect((await findJob(job.id))!.attempts).toBe(2);
  });

  it('does not retry a failure the handler says is permanent', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 5 });
    let attempts = 0;

    startWorker(async () => {
      attempts += 1;
      throw new NonRetryableJobError('The repository is no longer connected.');
    });

    await eventually(async () => (await statusOf(job.id)) === 'failed');
    // Give the loop room to make a second attempt if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(attempts).toBe(1);
    expect((await findJob(job.id))!.lastError).toBe('The repository is no longer connected.');
  });

  it('aborts the context signal on stop', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 3 });
    let observed: AbortSignal | null = null;

    const worker = startWorker(async (_payload, ctx) => {
      observed = ctx.signal;
      // Runs until told to stop, which is what a long analysis looks like from
      // the worker's point of view.
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve());
      });
      throw new Error('Interrupted');
    });

    await eventually(async () => (await statusOf(job.id)) === 'running');
    await worker.stop();

    expect(observed!.aborted).toBe(true);

    // Handed back rather than counted as a failure: shutting down taught nobody
    // anything about whether this job can succeed.
    expect((await findJob(job.id))!.lastError).toBeNull();

    const [reclaimed] = await claim('another-worker', [KIND], 1, 30_000);
    expect(reclaimed?.id).toBe(job.id);
  });

  it('waits for in flight handlers on stop', async () => {
    await enqueue({ kind: KIND });
    let finished = false;
    let started = false;

    const worker = startWorker(async (_payload, ctx) => {
      started = true;
      // Ignores the abort and keeps working, which is what a handler in the
      // middle of a write that must not be torn in half looks like.
      void ctx.signal;
      await new Promise((resolve) => setTimeout(resolve, 300));
      finished = true;
    });

    await eventually(async () => started);
    await worker.stop();

    // Resolved only once the handler returned. Abandoning it here is how a
    // half-finished write escapes into the database.
    expect(finished).toBe(true);
  });
});
