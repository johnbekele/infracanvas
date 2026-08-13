/**
 * The experiment endpoints against a real database and a real session.
 *
 * Nothing here is stubbed, so what these tests pin is the part a unit test
 * cannot: that scoping by user id actually reaches the SQL, that a concurrent
 * append is refused with a body the page can act on, and that a fork is one
 * transaction rather than two writes that can half-succeed.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IR_VERSION, type ArchitectureIr } from '@infracanvas/ir-schema';
import {
  PROFILE_SCHEMA_VERSION,
  type AppProfile,
  type Component,
  type DetectedDependency,
} from '@infracanvas/core';
import { closePool, query } from '../../lib/db/client.js';
import { findOrCreateUser } from '../../lib/db/users.js';
import { connectRepository } from '../../lib/db/repositories.js';
import { completeAnalysis, startAnalysis } from '../../lib/db/analyses.js';
import { createSessionToken } from '../../lib/jwt.js';
import experimentRoutes from './index.js';

function document(over: Partial<ArchitectureIr> = {}): ArchitectureIr {
  return {
    irVersion: IR_VERSION,
    name: 'Baseline',
    provider: 'aws',
    region: 'ap-southeast-2',
    nodes: [{ id: 'vpc-main', kind: 'vpc', name: 'Main', params: { cidrBlock: '10.0.0.0/16' } }],
    edges: [],
    ...over,
  };
}

/**
 * A profile with one runnable HTTP service backed by Postgres, which is the least
 * that makes `proposeArchitecture` return an architecture rather than a gap.
 */
function profile(): AppProfile {
  const dependencies: DetectedDependency[] = [
    {
      name: 'express',
      ecosystem: 'npm',
      category: 'other',
      capability: 'http-server',
      sourcePath: 'apps/api/package.json',
    },
    {
      name: 'pg',
      ecosystem: 'npm',
      category: 'other',
      capability: 'postgres',
      sourcePath: 'apps/api/package.json',
    },
  ];

  const api: Component = {
    path: 'apps/api',
    name: 'api',
    kind: 'api',
    ecosystems: ['npm'],
    manifestPaths: ['apps/api/package.json'],
    dependencyCount: dependencies.length,
    capabilities: ['http-server', 'postgres'],
    dependencies,
    dockerfiles: ['apps/api/Dockerfile'],
    exposedPorts: [3000],
    composeService: null,
    deployable: true,
  };

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    commitSha: 'a'.repeat(40),
    ref: 'main',
    analysedAt: '2026-08-12T00:00:00.000Z',
    languages: [{ name: 'TypeScript', bytes: 4096, share: 1 }],
    components: [api],
    dependencies,
    composeServices: [],
    containerisation: {
      dockerfiles: ['apps/api/Dockerfile'],
      composeFiles: [],
      exposedPorts: [3000],
    },
    fileCount: 12,
    totalBytes: 4096,
    notes: [],
  };
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/experiments', experimentRoutes);

let nextAddress = 0;

/** A signed-in caller with a rate-limit bucket of its own. */
async function signedIn(userId: string, githubId = 1, githubUsername = 'octocat') {
  const token = await createSessionToken({ userId, githubId, githubUsername });
  nextAddress += 1;
  const address = `198.51.100.${nextAddress}`;

  const authed = (base: request.Test) =>
    base.set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', address);

  return {
    get: (path: string) => authed(request(app).get(path)),
    post: (path: string) => authed(request(app).post(path)),
    patch: (path: string) => authed(request(app).patch(path)),
    delete: (path: string) => authed(request(app).delete(path)),
  };
}

async function makeUser(githubId = 1, username = 'octocat') {
  return findOrCreateUser({
    githubId,
    githubUsername: username,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });
}

async function makeRepository(userId: string, githubId = 987_654, name = 'hello-world') {
  return connectRepository({
    userId,
    githubId,
    githubOwner: 'octocat',
    githubName: name,
    defaultBranch: 'main',
    isPrivate: false,
  });
}

/** A repository with a succeeded analysis, which is what seeding reads. */
async function analysedRepository(userId: string) {
  const repository = await makeRepository(userId);
  const analysis = await startAnalysis(repository.id, 'main');
  await completeAnalysis(analysis.id, profile());
  return repository;
}

/** An experiment created from a document, which needs no analysis. */
async function makeExperiment(
  api: Awaited<ReturnType<typeof signedIn>>,
  over: Record<string, unknown> = {}
) {
  const response = await api.post('/experiments').send({
    name: 'Aurora Serverless',
    hypothesis: 'Aurora is cheaper than RDS under bursty load',
    ir: document(),
    ...over,
  });
  expect(response.status).toBe(201);
  return response.body as { experiment: { id: string }; head: { id: string; seq: number } };
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('POST /experiments', () => {
  it('creates an experiment seeded from the newest succeeded analysis', async () => {
    const user = await makeUser();
    const repository = await analysedRepository(user.id);
    const api = await signedIn(user.id);

    const response = await api.post('/experiments').send({
      repositoryId: repository.id,
      name: 'Baseline from analysis',
      hypothesis: 'The proposed architecture is the one to beat',
    });

    expect(response.status).toBe(201);
    expect(response.body.experiment.repositoryId).toBe(repository.id);
    // Revision 1 is the proposal, and it exists before any client has seen the
    // experiment: the row and its first revision commit together.
    expect(response.body.head.seq).toBe(1);
    expect(response.body.head.source).toBe('proposal');
    expect(response.body.head.authorKind).toBe('system');
    expect(response.body.head.ir.nodes.length).toBeGreaterThan(0);
    expect(response.body.experiment.headRevisionId).toBe(response.body.head.id);
  });

  it('refuses with 409 when the repository has no succeeded analysis', async () => {
    // The request is well formed; the repository is simply not in a state that
    // can seed an architecture, and an empty canvas would look like a bug.
    const user = await makeUser();
    const repository = await makeRepository(user.id);
    const api = await signedIn(user.id);

    const response = await api.post('/experiments').send({
      repositoryId: repository.id,
      name: 'Too early',
      hypothesis: 'There is nothing to seed from yet',
    });

    expect(response.status).toBe(409);
    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM experiments');
    expect(rows[0].count).toBe('0');
  });

  it('refuses to create an experiment against another user\u2019s repository', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await analysedRepository(alice.id);
    const api = await signedIn(bob.id, 2, 'bob');

    const response = await api.post('/experiments').send({
      repositoryId: hers.id,
      name: 'Not mine',
      hypothesis: 'Someone else\u2019s repository',
    });

    expect(response.status).toBe(404);
    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM experiments');
    expect(rows[0].count).toBe('0');
  });

  it('starts from a supplied document when one is given', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);

    const created = await makeExperiment(api);

    expect(created.head.seq).toBe(1);
    expect((created.head as unknown as { source: string }).source).toBe('import');
  });

  it('writes no experiment when the document does not validate', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);

    const response = await api.post('/experiments').send({
      name: 'Broken',
      hypothesis: 'An architecture nobody can price',
      ir: { ...document(), nodes: [{ id: 'vpc-main', kind: 'vpc', name: 'Main', params: {} }] },
    });

    expect(response.status).toBe(400);
    expect(response.body.problems.length).toBeGreaterThan(0);
    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM experiments');
    expect(rows[0].count).toBe('0');
  });
});

describe('GET /experiments', () => {
  it('lists only the caller\u2019s experiments', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await signedIn(alice.id, 1, 'alice');
    const his = await signedIn(bob.id, 2, 'bob');

    await makeExperiment(hers, { name: 'Hers' });
    await makeExperiment(his, { name: 'His' });

    const response = await hers.get('/experiments');

    expect(response.status).toBe(200);
    expect(response.body.experiments.map((e: { name: string }) => e.name)).toEqual(['Hers']);
  });

  it('hides archived experiments unless asked for them', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const kept = await makeExperiment(api, { name: 'Kept' });
    const shelved = await makeExperiment(api, { name: 'Shelved' });

    await api.patch(`/experiments/${shelved.experiment.id}`).send({ archived: true });

    const hidden = await api.get('/experiments');
    expect(hidden.body.experiments.map((e: { id: string }) => e.id)).toEqual([kept.experiment.id]);

    const all = await api.get('/experiments?includeArchived=true');
    expect(all.body.experiments).toHaveLength(2);
  });
});

describe('GET /experiments/:id', () => {
  it('returns the experiment with its head revision', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const created = await makeExperiment(api);

    const response = await api.get(`/experiments/${created.experiment.id}`);

    expect(response.status).toBe(200);
    expect(response.body.head.id).toBe(created.head.id);
    expect(response.body.head.ir.nodes[0].id).toBe('vpc-main');
  });
});

describe('POST /experiments/:id/revisions', () => {
  it('appends a revision and moves the head', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const created = await makeExperiment(api);

    const response = await api.post(`/experiments/${created.experiment.id}/revisions`).send({
      parentId: created.head.id,
      ir: document({ name: 'Aurora' }),
      summary: 'Swap RDS for Aurora Serverless v2',
      source: 'canvas_edit',
    });

    expect(response.status).toBe(201);
    expect(response.body.revision.seq).toBe(2);
    expect(response.body.revision.parentId).toBe(created.head.id);
    expect(response.body.revision.authorUserId).toBe(user.id);
    // The patch is derived and stored even though the caller sent none.
    expect(response.body.revision.patch).toEqual([
      { op: 'replace', path: '/name', value: 'Aurora' },
    ]);

    const reread = await api.get(`/experiments/${created.experiment.id}`);
    expect(reread.body.experiment.headRevisionId).toBe(response.body.revision.id);
  });

  it('returns 409 with the new head when the parent is not the head', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const created = await makeExperiment(api);

    const second = await api.post(`/experiments/${created.experiment.id}/revisions`).send({
      parentId: created.head.id,
      ir: document({ name: 'Aurora' }),
      summary: 'Swap RDS for Aurora Serverless v2',
      source: 'canvas_edit',
    });
    expect(second.status).toBe(201);

    // A second tab that still believes revision 1 is current.
    const stale = await api.post(`/experiments/${created.experiment.id}/revisions`).send({
      parentId: created.head.id,
      ir: document({ name: 'Something else' }),
      summary: 'An edit from a stale tab',
      source: 'canvas_edit',
    });

    expect(stale.status).toBe(409);
    // The page needs both to offer a rebase or a discard without another request.
    expect(stale.body.headRevisionId).toBe(second.body.revision.id);
    expect(stale.body.headSeq).toBe(2);

    const timeline = await api.get(`/experiments/${created.experiment.id}/revisions`);
    expect(timeline.body.revisions).toHaveLength(2);
  });

  it('returns the timeline without the documents', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const created = await makeExperiment(api);
    await api.post(`/experiments/${created.experiment.id}/revisions`).send({
      parentId: created.head.id,
      ir: document({ name: 'Aurora' }),
      summary: 'Swap RDS for Aurora Serverless v2',
      source: 'canvas_edit',
    });

    const response = await api.get(`/experiments/${created.experiment.id}/revisions`);

    expect(response.status).toBe(200);
    expect(response.body.revisions.map((r: { seq: number }) => r.seq)).toEqual([2, 1]);
    expect(response.body.revisions[0]).not.toHaveProperty('ir');
    expect(response.body.revisions[0].patchOps).toBe(1);
  });

  it('returns one revision with its document', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const created = await makeExperiment(api);

    const response = await api.get(
      `/experiments/${created.experiment.id}/revisions/${created.head.id}`
    );

    expect(response.status).toBe(200);
    expect(response.body.revision.ir.nodes[0].id).toBe('vpc-main');
  });
});

describe('POST /experiments/:id/fork', () => {
  it('forks the head into a new experiment with its own chain', async () => {
    const user = await makeUser();
    const repository = await analysedRepository(user.id);
    const api = await signedIn(user.id);
    const origin = await makeExperiment(api, { repositoryId: repository.id });

    const response = await api.post(`/experiments/${origin.experiment.id}/fork`).send({
      name: 'Aurora alternative',
      hypothesis: 'Aurora Serverless v2 is cheaper below a 40% duty cycle',
    });

    expect(response.status).toBe(201);
    expect(response.body.experiment.id).not.toBe(origin.experiment.id);
    // A separate thing being tested, so its own numbering starts again at 1. A
    // shared sequence would make "revision 4" ambiguous across the two.
    expect(response.body.head.seq).toBe(1);
    expect(response.body.head.parentId).toBeNull();
    expect(response.body.head.source).toBe('fork');
    // Lineage on the experiment, not the revision, so a revision's parent is
    // always inside its own experiment.
    expect(response.body.experiment.forkedFromExperimentId).toBe(origin.experiment.id);
    expect(response.body.experiment.forkedFromRevisionId).toBe(origin.head.id);
    // The repository is inherited: a fork tests an alternative to the same
    // application, so comparing across repositories would be meaningless.
    expect(response.body.experiment.repositoryId).toBe(repository.id);
    // And the document came across intact.
    expect(response.body.head.ir.nodes[0].id).toBe('vpc-main');
  });

  it('forks a named revision rather than the head', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const origin = await makeExperiment(api);

    const second = await api.post(`/experiments/${origin.experiment.id}/revisions`).send({
      parentId: origin.head.id,
      ir: document({ name: 'Aurora' }),
      summary: 'Swap RDS for Aurora Serverless v2',
      source: 'canvas_edit',
    });
    expect(second.status).toBe(201);

    const response = await api.post(`/experiments/${origin.experiment.id}/fork`).send({
      revisionId: origin.head.id,
      name: 'Back to the baseline',
      hypothesis: 'The first draft was the cheaper one',
    });

    expect(response.status).toBe(201);
    expect(response.body.experiment.forkedFromRevisionId).toBe(origin.head.id);
    // The forked document is revision 1's, not the head's.
    expect(response.body.head.ir.name).toBe('Baseline');
  });

  it('refuses to fork a revision from another experiment', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const mine = await makeExperiment(api, { name: 'Mine' });
    const other = await makeExperiment(api, { name: 'Other' });

    const response = await api.post(`/experiments/${mine.experiment.id}/fork`).send({
      revisionId: other.head.id,
      name: 'Crossed wires',
      hypothesis: 'A revision from somewhere else',
    });

    expect(response.status).toBe(404);
  });
});

describe('DELETE /experiments/:id', () => {
  it('removes the experiment and its history', async () => {
    const user = await makeUser();
    const api = await signedIn(user.id);
    const created = await makeExperiment(api);

    expect((await api.delete(`/experiments/${created.experiment.id}`)).status).toBe(204);

    expect((await api.get(`/experiments/${created.experiment.id}`)).status).toBe(404);
    const { rows } = await query<{ count: string }>(
      'SELECT count(*) AS count FROM experiment_revisions'
    );
    expect(rows[0].count).toBe('0');
  });
});

describe('scoping', () => {
  it('returns 404 for an experiment belonging to another user on every route', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await signedIn(alice.id, 1, 'alice');
    const his = await signedIn(bob.id, 2, 'bob');
    const created = await makeExperiment(hers, { name: 'Hers' });

    const id = created.experiment.id;
    const responses = await Promise.all([
      his.get(`/experiments/${id}`),
      his.patch(`/experiments/${id}`).send({ name: 'Mine now' }),
      his.delete(`/experiments/${id}`),
      his.post(`/experiments/${id}/fork`).send({ name: 'Stolen', hypothesis: 'Not mine' }),
      his.get(`/experiments/${id}/revisions`),
      his.get(`/experiments/${id}/revisions/${created.head.id}`),
      his.post(`/experiments/${id}/revisions`).send({
        parentId: created.head.id,
        ir: document({ name: 'Intruder' }),
        summary: 'An edit from the wrong account',
        source: 'canvas_edit',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404, 404, 404,
    ]);

    // And nothing was changed on the way to refusing.
    const untouched = await hers.get(`/experiments/${id}`);
    expect(untouched.body.experiment.name).toBe('Hers');
    expect(untouched.body.head.id).toBe(created.head.id);
  });
});
