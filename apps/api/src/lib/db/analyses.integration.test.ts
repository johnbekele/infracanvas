/**
 * The analysis lifecycle now that a run is queued before it starts.
 *
 * The distinction between `pending` and `running` is the point: it is what lets
 * the page say "queued" rather than claiming work has begun, and it is what makes
 * "how long has this been going" answerable when something is stuck.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_SCHEMA_VERSION,
  proposeArchitecture,
  type AppProfile,
  type ArchitectureProposal,
} from '@infracanvas/core';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { connectRepository } from './repositories.js';
import {
  AnalysisInProgressError,
  beginAnalysis,
  completeAnalysis,
  failAnalysis,
  findAnalysis,
  latestSucceededAnalysis,
  listAnalyses,
  queueAnalysis,
} from './analyses.js';

const profile: AppProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  commitSha: 'c'.repeat(40),
  ref: 'main',
  analysedAt: '2026-08-12T00:00:00.000Z',
  languages: [{ name: 'Python', bytes: 2000, share: 1 }],
  components: [
    {
      path: 'apps/api',
      name: 'api',
      kind: 'api',
      ecosystems: ['pypi'],
      manifestPaths: ['apps/api/pyproject.toml'],
      dependencyCount: 2,
      capabilities: ['http-server', 'postgres'],
      dependencies: [
        {
          name: 'fastapi',
          ecosystem: 'pypi',
          category: 'web-framework',
          capability: 'http-server',
          sourcePath: 'apps/api/pyproject.toml',
        },
        {
          name: 'asyncpg',
          ecosystem: 'pypi',
          category: 'datastore',
          capability: 'postgres',
          sourcePath: 'apps/api/pyproject.toml',
        },
      ],
      dockerfiles: ['apps/api/Dockerfile'],
      exposedPorts: [8000],
      composeService: 'api',
      deployable: true,
    },
  ],
  dependencies: [
    {
      name: 'fastapi',
      ecosystem: 'pypi',
      category: 'web-framework',
      capability: 'http-server',
      sourcePath: 'apps/api/pyproject.toml',
    },
    {
      name: 'asyncpg',
      ecosystem: 'pypi',
      category: 'datastore',
      capability: 'postgres',
      sourcePath: 'apps/api/pyproject.toml',
    },
  ],
  composeServices: [
    {
      name: 'api',
      file: 'docker-compose.yml',
      buildContext: 'apps/api',
      image: null,
      capability: null,
      ports: [8000],
      dependsOn: ['db'],
    },
    {
      name: 'db',
      file: 'docker-compose.yml',
      buildContext: null,
      image: 'postgres:16',
      capability: 'postgres',
      ports: [5432],
      dependsOn: [],
    },
  ],
  containerisation: {
    dockerfiles: ['apps/api/Dockerfile'],
    composeFiles: ['docker-compose.yml'],
    exposedPorts: [8000],
  },
  notes: [],
  fileCount: 40,
  totalBytes: 20_000,
};

const architecture: ArchitectureProposal = proposeArchitecture(profile, 'shop');

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

    const retried: AppProfile = {
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

    const done = await completeAnalysis(
      queued.id,
      retried,
      proposeArchitecture(retried, 'hello-world')
    );

    expect(done.status).toBe('succeeded');
    expect(done.commitSha).toBe('a'.repeat(40));
    // A run that succeeded on a retry must not still be showing the error from
    // the attempt before it.
    expect(done.error).toBeNull();
    expect((await findAnalysis(queued.id))!.profile!.fileCount).toBe(3);
  });
});

describe('the proposal stored with a completed run', () => {
  it('stores the proposed architecture alongside the profile', async () => {
    const repository = await makeRepository();
    const run = await queueAnalysis(repository.id, 'main');

    const completed = await completeAnalysis(run.id, profile, architecture);

    expect(completed.status).toBe('succeeded');
    expect(completed.architecture?.name).toBe('shop architecture');
    expect(completed.architecture?.nodes.length).toBe(architecture.nodes.length);
  });

  it('keeps every decision, its rationale, and its evidence paths', async () => {
    // The evidence is the point of storing the proposal: a user rejecting a
    // suggestion is disagreeing with a claim about a specific file.
    const repository = await makeRepository();
    const run = await queueAnalysis(repository.id, 'main');

    const completed = await completeAnalysis(run.id, profile, architecture);

    const service = completed.architecture?.nodes.find((node) => node.componentPath === 'apps/api');
    const compute = completed.architecture?.decisions.find(
      (decision) => decision.nodeId === service?.id
    );
    expect(compute?.rationale.length).toBeGreaterThan(0);
    expect(compute?.evidence).toContain('apps/api/Dockerfile');
    expect(compute?.evidence).toContain('apps/api/pyproject.toml');
    expect(compute?.confidence).toBe('high');
  });

  it('round-trips the proposal through jsonb without changing it', async () => {
    // jsonb does not preserve key order, so the comparison is structural. What
    // matters is that nothing is lost or coerced on the way through.
    const repository = await makeRepository();
    const run = await queueAnalysis(repository.id, 'main');

    const completed = await completeAnalysis(run.id, profile, architecture);

    expect(completed.architecture).toEqual(architecture);
  });

  it('serves the stored proposal to every later read of the run', async () => {
    const repository = await makeRepository();
    const run = await queueAnalysis(repository.id, 'main');
    await completeAnalysis(run.id, profile, architecture);

    const found = await findAnalysis(run.id);
    const listed = await listAnalyses(repository.id);
    const latest = await latestSucceededAnalysis(repository.id);

    expect(found?.architecture).toEqual(architecture);
    expect(listed[0].architecture).toEqual(architecture);
    expect(latest?.architecture).toEqual(architecture);
  });
});

describe('a run that never produced a proposal', () => {
  it('reports a null architecture while it is still running', async () => {
    const repository = await makeRepository();
    const run = await queueAnalysis(repository.id, 'main');

    expect(run.architecture).toBeNull();
  });

  it('reports a null architecture for a failed run', async () => {
    const repository = await makeRepository();
    const run = await queueAnalysis(repository.id, 'main');

    const failed = await failAnalysis(run.id, 'GitHub refused the request');

    expect(failed.architecture).toBeNull();
    expect(failed.error).toBe('GitHub refused the request');
  });

  it('leaves an earlier stored proposal untouched when a later run fails', async () => {
    // A failed retry must not blank the architecture the user is looking at.
    const repository = await makeRepository();
    const first = await queueAnalysis(repository.id, 'main');
    await completeAnalysis(first.id, profile, architecture);

    const second = await queueAnalysis(repository.id, 'main');
    await failAnalysis(second.id, 'rate limited');

    expect((await latestSucceededAnalysis(repository.id))?.architecture).toEqual(architecture);
  });
});
