/**
 * The analysis lifecycle now that a run is queued before it starts.
 *
 * The distinction between `pending` and `running` is the point: it is what lets
 * the page say "queued" rather than claiming work has begun, and it is what makes
 * "how long has this been going" answerable when something is stuck.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_SCHEMA_VERSION, type AppProfile } from '@infracanvas/core';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { connectRepository } from './repositories.js';
import {
  AnalysisInProgressError,
  beginAnalysis,
  completeAnalysis,
  failAnalysis,
  findAnalysis,
  queueAnalysis,
} from './analyses.js';

async function makeRepository() {
  const user = await findOrCreateUser({
    githubId: 314_159,
    githubUsername: 'octocat',
    githubAvatar: 'https://avatars.githubusercontent.com/u/314159',
  });

  return connectRepository({
    userId: user.id,
    githubId: 271_828,
    githubOwner: 'octocat',
    githubName: 'hello-world',
    defaultBranch: 'main',
    isPrivate: false,
  });
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('queueAnalysis', () => {
  it('records a run that has not started', async () => {
    const repository = await makeRepository();

    const analysis = await queueAnalysis(repository.id, 'main');

    expect(analysis.status).toBe('pending');
    // Null until a worker picks it up, so elapsed time measures the work rather
    // than the wait.
    expect(analysis.startedAt).toBeNull();
    expect(analysis.profile).toBeNull();
  });

  it('refuses a second run while one is in flight', async () => {
    const repository = await makeRepository();
    await queueAnalysis(repository.id, 'main');

    // The one-active-run rule has to hold for a queued run too, or a user
    // clicking twice enqueues two workers to analyse the same commit.
    await expect(queueAnalysis(repository.id, 'main')).rejects.toThrow(AnalysisInProgressError);
  });

  it('allows a new run once the previous one finished', async () => {
    const repository = await makeRepository();
    const first = await queueAnalysis(repository.id, 'main');
    await failAnalysis(first.id, 'GitHub returned 502');

    const second = await queueAnalysis(repository.id, 'main');

    expect(second.id).not.toBe(first.id);
  });
});

describe('beginAnalysis', () => {
  it('marks the run started when a worker picks it up', async () => {
    const repository = await makeRepository();
    const queued = await queueAnalysis(repository.id, 'main');

    const started = await beginAnalysis(queued.id);

    expect(started!.status).toBe('running');
    expect(started!.startedAt).not.toBeNull();
  });

  it('keeps the original start time across a retry', async () => {
    const repository = await makeRepository();
    const queued = await queueAnalysis(repository.id, 'main');

    const first = await beginAnalysis(queued.id);
    const second = await beginAnalysis(queued.id);

    // A retry is another attempt at the same run. Moving the start time would
    // reset the elapsed time the user is watching every time the queue backs off.
    expect(second!.startedAt!.getTime()).toBe(first!.startedAt!.getTime());
  });

  it('refuses to reopen a run that already finished', async () => {
    const repository = await makeRepository();
    const queued = await queueAnalysis(repository.id, 'main');
    await failAnalysis(queued.id, 'GitHub returned 404');

    // How a worker that claimed a lapsed lease -- while the first worker was in
    // fact finishing -- learns not to redo the work or reopen the result.
    expect(await beginAnalysis(queued.id)).toBeNull();
  });

  it('does nothing for an analysis that no longer exists', async () => {
    expect(await beginAnalysis('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('completeAnalysis', () => {
  it('stores the profile and clears an error from an earlier attempt', async () => {
    const repository = await makeRepository();
    const queued = await queueAnalysis(repository.id, 'main');
    await beginAnalysis(queued.id);
    await failAnalysis(queued.id, 'GitHub returned 502');

    const profile: AppProfile = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      commitSha: 'a'.repeat(40),
      ref: 'main',
      analysedAt: new Date().toISOString(),
      languages: [],
      components: [],
      dependencies: [],
      composeServices: [],
      containerisation: { dockerfiles: [], composeFiles: [], exposedPorts: [] },
      fileCount: 3,
      totalBytes: 100,
      notes: [],
    };

    const done = await completeAnalysis(queued.id, profile);

    expect(done.status).toBe('succeeded');
    expect(done.commitSha).toBe('a'.repeat(40));
    // A run that succeeded on a retry must not still be showing the error from
    // the attempt before it.
    expect(done.error).toBeNull();
    expect((await findAnalysis(queued.id))!.profile!.fileCount).toBe(3);
  });
});
