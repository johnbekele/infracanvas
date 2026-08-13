/**
 * What the experiment routes accept and refuse, with the data layer stubbed.
 *
 * The rules under test are the ones a browser can violate: an architecture that
 * does not validate, a summary longer than the column, a verdict with no reason,
 * and a body claiming to have been written by somebody else. None of them need a
 * database to be wrong, and each is cheaper to pin here than in a suite that does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { IR_VERSION, type ArchitectureIr } from '@infracanvas/ir-schema';
import type * as ExperimentsModule from '../../lib/db/experiments.js';
import type * as RevisionsModule from '../../lib/db/experiment-revisions.js';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://localhost:5433/unused';
  process.env.JWT_SECRET ??= 'test-secret-value-for-signing-tokens-only';
  process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
  process.env.APP_URL ??= 'http://localhost:5173';
  process.env.API_URL ??= 'http://localhost:3001';
  process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
});

const SESSION_USER = '11111111-1111-4111-8111-111111111111';
const EXPERIMENT_ID = '22222222-2222-4222-8222-222222222222';
const HEAD_ID = '33333333-3333-4333-8333-333333333333';

const experimentRow = {
  id: EXPERIMENT_ID,
  userId: SESSION_USER,
  repositoryId: null,
  name: 'Aurora Serverless',
  status: 'draft' as const,
  hypothesis: 'Aurora is cheaper under bursty load',
  headRevisionId: HEAD_ID,
  forkedFromExperimentId: null,
  forkedFromRevisionId: null,
  verdict: 'undecided' as const,
  verdictNote: null,
  verdictAt: null,
  archivedAt: null,
  expiresAt: new Date('2026-08-13T00:00:00Z'),
  budgetUsd: 25,
  createdAt: new Date('2026-08-12T00:00:00Z'),
  updatedAt: new Date('2026-08-12T00:00:00Z'),
};

function document(): ArchitectureIr {
  return {
    irVersion: IR_VERSION,
    name: 'Baseline',
    provider: 'aws',
    region: 'ap-southeast-2',
    nodes: [{ id: 'vpc-main', kind: 'vpc', name: 'Main', params: { cidrBlock: '10.0.0.0/16' } }],
    edges: [],
  };
}

const revisionRow = {
  id: HEAD_ID,
  experimentId: EXPERIMENT_ID,
  seq: 1,
  parentId: null,
  ir: document(),
  irVersion: IR_VERSION,
  patch: null,
  summary: 'Proposed from the analysis',
  source: 'proposal' as const,
  authorKind: 'system' as const,
  authorUserId: null,
  authorAgent: null,
  createdAt: new Date('2026-08-12T00:00:00Z'),
};

/** Whether the stubbed middleware puts a session on the request. */
let authenticated = true;

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!authenticated) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.session = { userId: SESSION_USER, githubId: 1, githubUsername: 'octocat' };
    next();
  },
}));

const findExperiment = vi.fn();
const renameExperiment = vi.fn();
const recordVerdict = vi.fn();
const setExperimentArchived = vi.fn();
const deleteExperiment = vi.fn();
const listExperiments = vi.fn();

vi.mock('../../lib/db/experiments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExperimentsModule>();
  return {
    ...actual,
    findExperiment: (...args: unknown[]) => findExperiment(...args),
    renameExperiment: (...args: unknown[]) => renameExperiment(...args),
    recordVerdict: (...args: unknown[]) => recordVerdict(...args),
    setExperimentArchived: (...args: unknown[]) => setExperimentArchived(...args),
    deleteExperiment: (...args: unknown[]) => deleteExperiment(...args),
    listExperiments: (...args: unknown[]) => listExperiments(...args),
  };
});

const appendRevision = vi.fn();
const headRevision = vi.fn();
const listRevisions = vi.fn();
const findRevision = vi.fn();

// The error classes stay real, because the routes branch on them with
// `instanceof` and a stub that only looked like one would not be caught.
vi.mock('../../lib/db/experiment-revisions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RevisionsModule>();
  return {
    ...actual,
    appendRevision: (...args: unknown[]) => appendRevision(...args),
    headRevision: (...args: unknown[]) => headRevision(...args),
    listRevisions: (...args: unknown[]) => listRevisions(...args),
    findRevision: (...args: unknown[]) => findRevision(...args),
  };
});

let nextAddress = 0;

/** A caller nothing else in this file shares a rate-limit bucket with. */
async function client() {
  const { default: experimentRoutes } = await import('./index.js');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/experiments', experimentRoutes);

  nextAddress += 1;
  const address = `203.0.113.${nextAddress}`;

  return {
    get: (path: string) => request(app).get(path).set('X-Forwarded-For', address),
    post: (path: string) => request(app).post(path).set('X-Forwarded-For', address),
    patch: (path: string) => request(app).patch(path).set('X-Forwarded-For', address),
    delete: (path: string) => request(app).delete(path).set('X-Forwarded-For', address),
  };
}

beforeEach(() => {
  authenticated = true;
  vi.clearAllMocks();
  findExperiment.mockResolvedValue(experimentRow);
  headRevision.mockResolvedValue(revisionRow);
  listRevisions.mockResolvedValue([]);
  listExperiments.mockResolvedValue([]);
  findRevision.mockResolvedValue(revisionRow);
  appendRevision.mockResolvedValue({ ...revisionRow, seq: 2, parentId: HEAD_ID });
  renameExperiment.mockResolvedValue(experimentRow);
  recordVerdict.mockResolvedValue(experimentRow);
  setExperimentArchived.mockResolvedValue(experimentRow);
  deleteExperiment.mockResolvedValue(true);
});

describe('authentication', () => {
  it('refuses every route without a session', async () => {
    authenticated = false;
    const api = await client();

    const responses = await Promise.all([
      api.get('/experiments'),
      api.post('/experiments'),
      api.get(`/experiments/${EXPERIMENT_ID}`),
      api.patch(`/experiments/${EXPERIMENT_ID}`),
      api.delete(`/experiments/${EXPERIMENT_ID}`),
      api.post(`/experiments/${EXPERIMENT_ID}/fork`),
      api.get(`/experiments/${EXPERIMENT_ID}/revisions`),
      api.get(`/experiments/${EXPERIMENT_ID}/revisions/${HEAD_ID}`),
      api.post(`/experiments/${EXPERIMENT_ID}/revisions`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401, 401, 401, 401, 401,
    ]);
    // Nothing was read on the way to refusing, so an unauthenticated request
    // cannot be used to find out whether an id exists.
    expect(findExperiment).not.toHaveBeenCalled();
  });
});

describe('POST /experiments/:id/revisions', () => {
  const valid = {
    parentId: HEAD_ID,
    ir: document(),
    summary: 'Swap RDS for Aurora Serverless v2',
    source: 'canvas_edit',
  };

  it('rejects an ir document that fails validation with the problems that failed', async () => {
    const api = await client();

    const response = await api.post(`/experiments/${EXPERIMENT_ID}/revisions`).send({
      ...valid,
      // A vpc with no cidrBlock. The canvas needs to know which pointer failed to
      // be able to highlight it; "invalid architecture" is not actionable.
      ir: { ...document(), nodes: [{ id: 'vpc-main', kind: 'vpc', name: 'Main', params: {} }] },
    });

    expect(response.status).toBe(400);
    expect(response.body.problems).toBeInstanceOf(Array);
    expect(response.body.problems.length).toBeGreaterThan(0);
    expect(response.body.problems[0]).toHaveProperty('pointer');
    expect(response.body.problems[0]).toHaveProperty('message');
    expect(appendRevision).not.toHaveBeenCalled();
  });

  it('rejects a summary longer than the column allows', async () => {
    const api = await client();

    const response = await api
      .post(`/experiments/${EXPERIMENT_ID}/revisions`)
      .send({ ...valid, summary: 'x'.repeat(201) });

    expect(response.status).toBe(400);
    expect(appendRevision).not.toHaveBeenCalled();
  });

  it('rejects an empty summary', async () => {
    const api = await client();

    const response = await api
      .post(`/experiments/${EXPERIMENT_ID}/revisions`)
      .send({ ...valid, summary: '' });

    expect(response.status).toBe(400);
  });

  it('rejects a source it does not recognise', async () => {
    const api = await client();

    const response = await api
      .post(`/experiments/${EXPERIMENT_ID}/revisions`)
      .send({ ...valid, source: 'telepathy' });

    expect(response.status).toBe(400);
    expect(appendRevision).not.toHaveBeenCalled();
  });

  it('requires a parentId', async () => {
    const api = await client();

    const response = await api
      .post(`/experiments/${EXPERIMENT_ID}/revisions`)
      .send({ ir: document(), summary: 'An edit', source: 'canvas_edit' });

    expect(response.status).toBe(400);
    expect(appendRevision).not.toHaveBeenCalled();
  });

  it('derives the author from the session rather than the body', async () => {
    const api = await client();

    const response = await api.post(`/experiments/${EXPERIMENT_ID}/revisions`).send({
      ...valid,
      // A client claiming its edit was written by the copilot, on behalf of
      // somebody else. Believing either would make the timeline a record of
      // whatever the last caller asserted.
      authorKind: 'copilot',
      authorUserId: '99999999-9999-4999-8999-999999999999',
      authorAgent: 'not-a-real-agent',
    });

    expect(response.status).toBe(201);
    expect(appendRevision).toHaveBeenCalledTimes(1);
    const [userId, input] = appendRevision.mock.calls[0];
    expect(userId).toBe(SESSION_USER);
    expect(input.authorKind).toBe('human');
    expect(input.authorUserId).toBe(SESSION_USER);
    expect(input.authorAgent).toBeUndefined();
    // `source` is the body's to give: only the client knows whether a document
    // came off the canvas or out of a patch.
    expect(input.source).toBe('canvas_edit');
  });

  it('answers 409 with the head when the parent is stale', async () => {
    const { RevisionConflictError } = await import('../../lib/db/experiment-revisions.js');
    appendRevision.mockRejectedValue(new RevisionConflictError(HEAD_ID, 7));
    const api = await client();

    const response = await api.post(`/experiments/${EXPERIMENT_ID}/revisions`).send(valid);

    expect(response.status).toBe(409);
    expect(response.body.headRevisionId).toBe(HEAD_ID);
    expect(response.body.headSeq).toBe(7);
  });

  it('answers 400 when the supplied patch does not describe the edit', async () => {
    const { PatchMismatchError } = await import('../../lib/db/experiment-revisions.js');
    appendRevision.mockRejectedValue(new PatchMismatchError());
    const api = await client();

    const response = await api
      .post(`/experiments/${EXPERIMENT_ID}/revisions`)
      .send({ ...valid, patch: [{ op: 'replace', path: '/name', value: 'Elsewhere' }] });

    expect(response.status).toBe(400);
  });

  it('rejects a patch that is not an array', async () => {
    const api = await client();

    const response = await api
      .post(`/experiments/${EXPERIMENT_ID}/revisions`)
      .send({ ...valid, patch: { op: 'replace' } });

    expect(response.status).toBe(400);
    expect(appendRevision).not.toHaveBeenCalled();
  });
});

describe('PATCH /experiments/:id', () => {
  it('refuses a verdict with no note', async () => {
    // A verdict with no reason is a badge rather than a result. Refused at the
    // route so the caller gets a reason rather than a constraint name.
    const api = await client();

    const response = await api.patch(`/experiments/${EXPERIMENT_ID}`).send({ verdict: 'reject' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/verdictNote/);
    expect(recordVerdict).not.toHaveBeenCalled();
  });

  it('accepts a verdict with a note', async () => {
    const api = await client();

    const response = await api
      .patch(`/experiments/${EXPERIMENT_ID}`)
      .send({ verdict: 'adopt', verdictNote: 'A third cheaper at the same p95' });

    expect(response.status).toBe(200);
    expect(recordVerdict).toHaveBeenCalledWith(
      SESSION_USER,
      EXPERIMENT_ID,
      'adopt',
      'A third cheaper at the same p95'
    );
  });

  it('accepts returning to undecided without a note', async () => {
    const api = await client();

    const response = await api
      .patch(`/experiments/${EXPERIMENT_ID}`)
      .send({ verdict: 'undecided' });

    expect(response.status).toBe(200);
  });

  it('rejects a verdict it does not recognise', async () => {
    const api = await client();

    const response = await api
      .patch(`/experiments/${EXPERIMENT_ID}`)
      .send({ verdict: 'maybe', verdictNote: 'Not one of the four' });

    expect(response.status).toBe(400);
    expect(recordVerdict).not.toHaveBeenCalled();
  });

  it('rejects a hypothesis longer than the column allows', async () => {
    const api = await client();

    const response = await api
      .patch(`/experiments/${EXPERIMENT_ID}`)
      .send({ hypothesis: 'x'.repeat(501) });

    expect(response.status).toBe(400);
    expect(renameExperiment).not.toHaveBeenCalled();
  });

  it('does not touch the revision chain when renaming', async () => {
    const api = await client();

    await api.patch(`/experiments/${EXPERIMENT_ID}`).send({ name: 'Aurora vs RDS' });

    expect(renameExperiment).toHaveBeenCalledWith(SESSION_USER, EXPERIMENT_ID, {
      name: 'Aurora vs RDS',
    });
    expect(appendRevision).not.toHaveBeenCalled();
  });
});

describe('POST /experiments', () => {
  it('requires a hypothesis', async () => {
    const api = await client();

    const response = await api.post('/experiments').send({ name: 'Aurora', ir: document() });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/hypothesis/);
  });

  it('requires either a repository to seed from or a document', async () => {
    const api = await client();

    const response = await api
      .post('/experiments')
      .send({ name: 'Aurora', hypothesis: 'Cheaper under bursty load' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/repositoryId or ir/);
  });

  it('rejects a ttl outside the bounds', async () => {
    const api = await client();

    for (const ttlHours of [0, -1, 24 * 15]) {
      const response = await api.post('/experiments').send({
        name: 'Aurora',
        hypothesis: 'Cheaper under bursty load',
        ir: document(),
        ttlHours,
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects a budget outside the bounds', async () => {
    const api = await client();

    for (const budgetUsd of [0, -5, 100_001]) {
      const response = await api.post('/experiments').send({
        name: 'Aurora',
        hypothesis: 'Cheaper under bursty load',
        ir: document(),
        budgetUsd,
      });
      expect(response.status).toBe(400);
    }
  });
});

describe('404s', () => {
  it('answers 404 rather than 403 for an experiment that is not the caller\u2019s', async () => {
    // Telling a caller that an id exists but is not theirs turns a uuid guess
    // into an oracle for who is testing what.
    findExperiment.mockResolvedValue(null);
    const api = await client();

    const responses = await Promise.all([
      api.get(`/experiments/${EXPERIMENT_ID}`),
      api.patch(`/experiments/${EXPERIMENT_ID}`).send({ name: 'Mine now' }),
      api.post(`/experiments/${EXPERIMENT_ID}/fork`).send({ name: 'F', hypothesis: 'H' }),
      api.get(`/experiments/${EXPERIMENT_ID}/revisions`),
      api.post(`/experiments/${EXPERIMENT_ID}/revisions`).send({
        parentId: HEAD_ID,
        ir: document(),
        summary: 'An edit',
        source: 'canvas_edit',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    expect(responses.every((response) => response.body.error === 'Experiment not found')).toBe(
      true
    );
  });
});
