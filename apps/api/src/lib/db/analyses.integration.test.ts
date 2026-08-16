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
  completeAnalysis,
  failAnalysis,
  findAnalysis,
  latestSucceededAnalysis,
  listAnalyses,
  startAnalysis,
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
    githubId: 4242,
    githubUsername: 'octocat',
    githubAvatar: 'https://avatars.githubusercontent.com/u/4242',
  });

  return connectRepository({
    userId: user.id,
    githubId: 55_555,
    githubOwner: 'octocat',
    githubName: 'shop',
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

describe('completeAnalysis', () => {
  it('stores the proposed architecture alongside the profile', async () => {
    const repository = await makeRepository();
    const run = await startAnalysis(repository.id, 'main');

    const completed = await completeAnalysis(run.id, profile, architecture);

    expect(completed.status).toBe('succeeded');
    expect(completed.architecture?.name).toBe('shop architecture');
    expect(completed.architecture?.nodes.length).toBe(architecture.nodes.length);
  });

  it('keeps every decision, its rationale, and its evidence paths', async () => {
    // The evidence is the point of storing the proposal: a user rejecting a
    // suggestion is disagreeing with a claim about a specific file.
    const repository = await makeRepository();
    const run = await startAnalysis(repository.id, 'main');

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
    const run = await startAnalysis(repository.id, 'main');

    const completed = await completeAnalysis(run.id, profile, architecture);

    expect(completed.architecture).toEqual(architecture);
  });

  it('serves the stored proposal to every later read of the run', async () => {
    const repository = await makeRepository();
    const run = await startAnalysis(repository.id, 'main');
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
    const run = await startAnalysis(repository.id, 'main');

    expect(run.architecture).toBeNull();
  });

  it('reports a null architecture for a failed run', async () => {
    const repository = await makeRepository();
    const run = await startAnalysis(repository.id, 'main');

    const failed = await failAnalysis(run.id, 'GitHub refused the request');

    expect(failed.architecture).toBeNull();
    expect(failed.error).toBe('GitHub refused the request');
  });

  it('leaves an earlier stored proposal untouched when a later run fails', async () => {
    // A failed retry must not blank the architecture the user is looking at.
    const repository = await makeRepository();
    const first = await startAnalysis(repository.id, 'main');
    await completeAnalysis(first.id, profile, architecture);

    const second = await startAnalysis(repository.id, 'main');
    await failAnalysis(second.id, 'rate limited');

    expect((await latestSucceededAnalysis(repository.id))?.architecture).toEqual(architecture);
  });
});
