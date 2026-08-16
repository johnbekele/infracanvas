/**
 * The queue's guarantees, against a real Postgres.
 *
 * These are all statements about concurrency and time, and none of them can be
 * checked against a mock: `SKIP LOCKED`, a partial index, and a lease compared to
 * `now()` are the mechanism, so a test that stubbed the database would only be
 * asserting that the stub was written to match.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '../db/client.js';
import { findOrCreateUser } from '../db/users.js';
import { connectRepository } from '../db/repositories.js';
import { queueAnalysis } from '../db/analyses.js';
import {
  appendEvent,
  claim,
  complete,
  discard,
  enqueue,
  expireStranded,
  fail,
  findJob,
  findJobForAnalysis,
  heartbeat,
  readEvents,
} from './queue.js';

const KIND = 'test.job';

beforeEach(async () => {
  await query('TRUNCATE users, jobs CASCADE');
});

afterAll(async () => {
  await closePool();
});

/** A job whose lease has already lapsed, as one held by a crashed worker would be. */
async function lapseLease(jobId: string) {
  await query(`UPDATE jobs SET leased_until = now() - interval '1 minute' WHERE id = $1`, [jobId]);
}

describe('claim', () => {
  it('two workers never claim the same job', async () => {
    await enqueue({ kind: KIND });

    // Concurrent rather than sequential: the bug this guards against lives in the
    // window between reading the candidates and marking them taken, and a
    // sequential claim never opens that window.
    const [first, second] = await Promise.all([
      claim('worker-a', [KIND], 5, 30_000),
      claim('worker-b', [KIND], 5, 30_000),
    ]);

    expect(first.length + second.length).toBe(1);
  });

  it('does not claim a job scheduled for the future', async () => {
    await enqueue({ kind: KIND, runAt: new Date(Date.now() + 60_000) });

    expect(await claim('worker-a', [KIND], 5, 30_000)).toEqual([]);
  });

  it('ignores kinds it has no handler for', async () => {
    await enqueue({ kind: 'some.other.kind' });

    expect(await claim('worker-a', [KIND], 5, 30_000)).toEqual([]);
  });

  it('claims in priority then age order', async () => {
    await enqueue({ kind: KIND, priority: 200, payload: { label: 'low priority' } });
    await enqueue({
      kind: KIND,
      priority: 10,
      payload: { label: 'newer, higher priority' },
      runAt: new Date(Date.now() - 1_000),
    });
    await enqueue({
      kind: KIND,
      priority: 10,
      payload: { label: 'older, higher priority' },
      runAt: new Date(Date.now() - 60_000),
    });

    // One at a time, because `RETURNING` does not promise the order of the
    // subquery: the guarantee under test is which job is taken next, not the
    // order rows come back in from a batch.
    const order: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [next] = await claim(`worker-${i}`, [KIND], 1, 30_000);
      order.push(next.payload.label);
    }

    // Priority decides first, and age breaks the tie, so a job does not sit
    // behind newer work of the same importance indefinitely.
    expect(order).toEqual(['older, higher priority', 'newer, higher priority', 'low priority']);
  });

  it('reclaims a job whose lease expired', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 3 });
    await claim('worker-a', [KIND], 1, 30_000);
    await lapseLease(job.id);

    const [reclaimed] = await claim('worker-b', [KIND], 1, 30_000);

    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.leaseOwner).toBe('worker-b');
    // The dead worker's attempt still counts, or a job that crashes the process
    // it runs in would be retried forever.
    expect(reclaimed.attempts).toBe(2);
  });

  it('does not reclaim a job that has no attempt left', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 1 });
    await claim('worker-a', [KIND], 1, 30_000);
    await lapseLease(job.id);

    expect(await claim('worker-b', [KIND], 1, 30_000)).toEqual([]);
  });
});

describe('heartbeat', () => {
  it('heartbeat from the lease holder extends the lease', async () => {
    const job = await enqueue({ kind: KIND });
    const [claimed] = await claim('worker-a', [KIND], 1, 1_000);

    expect(await heartbeat(job.id, 'worker-a', 60_000)).toBe(true);

    const after = await findJob(job.id);
    expect(after!.leasedUntil!.getTime()).toBeGreaterThan(claimed.leasedUntil!.getTime());
  });

  it('heartbeat from a stranger is refused', async () => {
    const job = await enqueue({ kind: KIND });
    await claim('worker-a', [KIND], 1, 30_000);

    // How a superseded worker learns it has been replaced, rather than carrying
    // on and running the job a second time alongside its new owner.
    expect(await heartbeat(job.id, 'worker-b', 30_000)).toBe(false);
  });
});

describe('complete', () => {
  it('marks the job succeeded and releases the lease', async () => {
    const job = await enqueue({ kind: KIND });
    await claim('worker-a', [KIND], 1, 30_000);

    await complete(job.id, 'worker-a');

    const after = await findJob(job.id);
    expect(after!.status).toBe('succeeded');
    expect(after!.leaseOwner).toBeNull();
  });

  it('complete from a stranger is refused', async () => {
    const job = await enqueue({ kind: KIND });
    await claim('worker-a', [KIND], 1, 30_000);

    await complete(job.id, 'worker-b');

    // A worker whose lease lapsed must not report success over the run that
    // replaced it, or a failure gets recorded as a pass.
    expect((await findJob(job.id))!.status).toBe('running');
  });
});

describe('fail', () => {
  it('requeues with backoff until max attempts', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 3 });
    await claim('worker-a', [KIND], 1, 30_000);

    const after = await fail(job.id, 'worker-a', 'GitHub returned 502');

    expect(after.status).toBe('queued');
    expect(after.lastError).toBe('GitHub returned 502');
    expect(after.runAt.getTime()).toBeGreaterThan(Date.now());
    // Backed off, so the retry is not immediate: a failure caused by something
    // that is down should not be retried into the same outage.
    expect(await claim('worker-a', [KIND], 1, 30_000)).toEqual([]);
  });

  it('backs off further on each attempt', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 4 });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await query('UPDATE jobs SET run_at = now() WHERE id = $1', [job.id]);
      await claim('worker-a', [KIND], 1, 30_000);
      const after = await fail(job.id, 'worker-a', 'still failing');
      delays.push(after.runAt.getTime() - Date.now());
    }

    expect(delays[1]).toBeGreaterThan(delays[0]);
  });

  it('marks the job failed on the final attempt', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 1 });
    await claim('worker-a', [KIND], 1, 30_000);

    const after = await fail(job.id, 'worker-a', 'not coming back');

    expect(after.status).toBe('failed');
    expect(await claim('worker-a', [KIND], 1, 30_000)).toEqual([]);
  });
});

describe('discard', () => {
  it('fails the job outright, without waiting for its remaining attempts', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 3 });
    await claim('worker-a', [KIND], 1, 30_000);

    await discard(job.id, 'worker-a', 'The repository is no longer connected.');

    const after = await findJob(job.id);
    expect(after!.status).toBe('failed');
    expect(after!.lastError).toBe('The repository is no longer connected.');
  });
});

describe('expireStranded', () => {
  it('retires a job abandoned on its final attempt', async () => {
    const job = await enqueue({ kind: KIND, maxAttempts: 1 });
    await claim('worker-a', [KIND], 1, 30_000);
    await lapseLease(job.id);

    const retired = await expireStranded();

    // Without this the row sits in `running` forever: `claim` cannot take it
    // without exceeding max_attempts, so nothing would ever resolve it.
    expect(retired.map((entry) => entry.id)).toEqual([job.id]);
    expect((await findJob(job.id))!.status).toBe('failed');
  });

  it('leaves a job alone while its lease holds', async () => {
    await enqueue({ kind: KIND, maxAttempts: 1 });
    await claim('worker-a', [KIND], 1, 30_000);

    expect(await expireStranded()).toEqual([]);
  });
});

describe('events', () => {
  it('readEvents after an id does not replay earlier events', async () => {
    const job = await enqueue({ kind: KIND });
    await appendEvent(job.id, { level: 'info', message: 'first', progress: 0.1 });
    await appendEvent(job.id, { level: 'info', message: 'second', progress: 0.5 });
    await appendEvent(job.id, { level: 'error', message: 'third' });

    const all = await readEvents(job.id);
    expect(all.map((event) => event.message)).toEqual(['first', 'second', 'third']);
    expect(all[0].progress).toBeCloseTo(0.1);
    expect(all[2].progress).toBeNull();

    // What a reconnecting stream does with Last-Event-ID: resume, not replay.
    const rest = await readEvents(job.id, all[0].id);
    expect(rest.map((event) => event.message)).toEqual(['second', 'third']);
  });
});

describe('claim under load', () => {
  it('claims from a large backlog using the index rather than a scan', async () => {
    // 100k rows, which is far beyond anything this application will queue, and
    // the size at which a sequential scan would be obvious.
    await query(
      `INSERT INTO jobs (kind, priority, run_at)
       SELECT $1, 100 + (i % 50), now() - make_interval(secs => i)
         FROM generate_series(1, 100000) AS i`,
      [KIND]
    );

    const plan = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM jobs
         WHERE kind = ANY($1::text[]) AND run_at <= now()
           AND attempts < max_attempts
           AND (status = 'queued' OR (status = 'running' AND leased_until < now()))
         ORDER BY priority, run_at
         LIMIT 1`,
      [[KIND]]
    );

    const explained = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(explained).toContain('jobs_claimable_idx');

    const started = performance.now();
    const claimed = await claim('worker-a', [KIND], 1, 30_000);
    const elapsed = performance.now() - started;

    expect(claimed).toHaveLength(1);
    // The spec's budget is 10ms. This is set an order of magnitude above it
    // because CI runs every package's suite at once on a shared runner, where the
    // number measures contention rather than the query.
    expect(elapsed).toBeLessThan(250);
  });
});

describe('findJobForAnalysis', () => {
  it('finds the job created for an analysis', async () => {
    const user = await findOrCreateUser({
      githubId: 4_242,
      githubUsername: 'octocat',
      githubAvatar: 'https://avatars.githubusercontent.com/u/4242',
    });
    const repository = await connectRepository({
      userId: user.id,
      githubId: 55,
      githubOwner: 'octocat',
      githubName: 'hello-world',
      defaultBranch: 'main',
      isPrivate: false,
    });
    const analysis = await queueAnalysis(repository.id, 'main');

    const job = await enqueue({ kind: KIND, analysisId: analysis.id });

    expect((await findJobForAnalysis(analysis.id))!.id).toBe(job.id);

    // The link cascades, so deleting a repository does not leave the queue
    // holding work for an analysis that no longer exists.
    await query('DELETE FROM repositories WHERE id = $1', [repository.id]);
    expect(await findJob(job.id)).toBeNull();
  });
});
