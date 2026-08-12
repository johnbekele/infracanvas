import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MIN_SERVICE_TOKEN_LENGTH,
  requireServiceToken,
  SERVICE_TOKEN_HEADER,
  serviceToken,
} from './service-token.js';

const TOKEN = 'f'.repeat(64);

function appWithGuard() {
  const app = express();
  app.get('/guarded', requireServiceToken, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  process.env.BRAIN_SERVICE_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.BRAIN_SERVICE_TOKEN;
  vi.restoreAllMocks();
});

describe('the service token guard', () => {
  it('admits the configured token', async () => {
    const response = await request(appWithGuard()).get('/guarded').set(SERVICE_TOKEN_HEADER, TOKEN);

    expect(response.status).toBe(200);
  });

  it('rejects a request with a wrong service token in constant time', async () => {
    // A token that shares a long prefix and one that shares nothing are both
    // refused the same way. The comparison runs over sha-256 digests of both
    // sides, so it is a fixed 32 bytes regardless of what was presented, and no
    // early return depends on the real token's length or contents.
    const nearMiss = `${TOKEN.slice(0, 63)}0`;
    const wrongLength = 'a';

    for (const presented of [nearMiss, wrongLength, '']) {
      const response = await request(appWithGuard())
        .get('/guarded')
        .set(SERVICE_TOKEN_HEADER, presented);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    }
  });

  it('rejects a request with no token at all', async () => {
    const response = await request(appWithGuard()).get('/guarded');

    expect(response.status).toBe(401);
  });

  it('never logs the service token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await request(appWithGuard()).get('/guarded').set(SERVICE_TOKEN_HEADER, 'wrong-token-value');

    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      const line = call.join(' ');
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain('wrong-token-value');
    }
  });

  it('treats a token below the minimum length as no token at all', () => {
    process.env.BRAIN_SERVICE_TOKEN = 'a'.repeat(MIN_SERVICE_TOKEN_LENGTH - 1);

    // Fails closed: the internal plane is then never mounted, so the path 404s
    // rather than accepting a credential nobody would have to guess for long.
    expect(serviceToken()).toBeUndefined();
  });

  it('reports no token when none is configured', () => {
    delete process.env.BRAIN_SERVICE_TOKEN;

    expect(serviceToken()).toBeUndefined();
  });
});
