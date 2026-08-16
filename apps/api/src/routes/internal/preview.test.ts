import { readFileSync } from 'node:fs';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { irDigest, type IrPatch, type PatchPreview } from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { corsMiddleware } from '../../middleware/cors.js';
import { SERVICE_TOKEN_HEADER } from '../../middleware/service-token.js';
import { mountInternalRoutes } from './index.js';

const TOKEN = 'e'.repeat(64);

function threeTier(): ArchitectureIr {
  return JSON.parse(
    readFileSync(
      new URL('../../../../../packages/ir-schema/fixtures/three-tier.json', import.meta.url),
      'utf8'
    )
  ) as ArchitectureIr;
}

function patchOf(ir: ArchitectureIr, ops: IrPatch['ops']): IrPatch {
  return { patchVersion: 1, basedOnIrDigest: irDigest(ir), summary: 'A change', ops };
}

/** The same order `src/index.ts` uses: JSON parsing, then the internal plane, then CORS. */
function app(): Express {
  const server = express();
  server.use(express.json({ limit: '10mb' }));
  mountInternalRoutes(server);
  server.use(corsMiddleware);
  server.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  return server;
}

function post(body: object, token: string | null = TOKEN) {
  const pending = request(app()).post('/internal/ir/preview').send(body);
  return token === null ? pending : pending.set(SERVICE_TOKEN_HEADER, token);
}

beforeEach(() => {
  process.env.BRAIN_SERVICE_TOKEN = TOKEN;
  process.env.APP_URL ??= 'http://localhost:5173';
});

afterEach(() => {
  delete process.env.BRAIN_SERVICE_TOKEN;
  vi.restoreAllMocks();
});

describe('POST /internal/ir/preview', () => {
  it('prices a patch against the document the caller supplied', async () => {
    const ir = threeTier();
    const response = await post({
      ir,
      patch: patchOf(ir, [
        { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true },
      ]),
      // The only region with a committed price list.
      region: 'us-east-1', // infracanvas-allow: no-hardcoded-region
    });

    expect(response.status).toBe(200);
    const preview = response.body.preview as PatchPreview;
    expect(preview.applicable).toBe(true);
    expect(preview.cost.monthlyUsdDelta).toBeGreaterThan(0);
    expect(preview.touchedNodeIds).toEqual(['rds-primary']);
    expect(response.body.patchedIrDigest).toBe(irDigest(response.body.patchedIr));
  });

  it('returns a patch that does not apply as a priced answer rather than an error', async () => {
    const ir = threeTier();
    const response = await post({
      ir,
      patch: patchOf(ir, [{ op: 'remove_node', nodeId: 'rds-primary' }]),
    });

    expect(response.status).toBe(200);
    expect(response.body.preview.applicable).toBe(false);
    expect(response.body.preview.problems[0].source).toBe('precondition');
    expect(response.body.patchedIr).toBeNull();
  });

  it('rejects a body that is not an IR document and a patch', async () => {
    expect((await post({ ir: {}, patch: {} })).status).toBe(400);
    expect((await post({ ir: threeTier() })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('performs no database query', async () => {
    // The pool is failed outright: a route that touched it would reject rather
    // than answer, so a 200 here is proof that it did not.
    const client = await import('../../lib/db/client.js');
    const query = vi.spyOn(client, 'query').mockRejectedValue(new Error('no database here'));

    const ir = threeTier();
    const response = await post({ ir, patch: patchOf(ir, []) });

    expect(response.status).toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a request with an absent, empty or wrong token', async () => {
    const ir = threeTier();
    const body = { ir, patch: patchOf(ir, []) };

    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, '')).status).toBe(401);
    expect((await post(body, 'a'.repeat(64))).status).toBe(401);
  });

  it('serves no internal route when the token is unconfigured', async () => {
    delete process.env.BRAIN_SERVICE_TOKEN;
    const ir = threeTier();

    const response = await post({ ir, patch: patchOf(ir, []) });

    // 404 rather than 401: a deployment with no second process has no
    // credential to leak, and 401 would say one exists.
    expect(response.status).toBe(404);
  });

  it('carries no Access-Control-Allow-Origin header', async () => {
    const ir = threeTier();
    const response = await request(app())
      .post('/internal/ir/preview')
      .set(SERVICE_TOKEN_HEADER, TOKEN)
      .set('Origin', 'http://localhost:5173')
      .send({ ir, patch: patchOf(ir, []) });

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('adds negligible overhead of its own to a preview', async () => {
    const ir = threeTier();
    const body = {
      ir,
      patch: patchOf(ir, [
        { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true },
      ]),
    };
    const server = app();

    // Warm the route, the registry and the baseline cache.
    await request(server).post('/internal/ir/preview').set(SERVICE_TOKEN_HEADER, TOKEN).send(body);

    const samples: number[] = [];
    for (let run = 0; run < 11; run += 1) {
      const started = performance.now();
      const response = await request(server)
        .post('/internal/ir/preview')
        .set(SERVICE_TOKEN_HEADER, TOKEN)
        .send(body);
      samples.push(performance.now() - started - response.body.preview.computedMs);
    }
    samples.sort((a, b) => a - b);

    // Measured on a development machine: a median of 0.3ms on top of the
    // preview itself, most of it supertest opening a socket per request. The
    // assertion is two orders of magnitude above that because CI runs every
    // package's suite concurrently on a small runner where the process spends
    // most of the interval descheduled (#152).
    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(50);
  });
});
