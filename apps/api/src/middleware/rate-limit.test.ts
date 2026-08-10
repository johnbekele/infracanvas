import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { apiRateLimit, authRateLimit } from './rate-limit.js';

/** A minimal app carrying one limiter, so each test starts with a fresh counter. */
function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.set('trust proxy', 0);
  app.get('/', limiter, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('apiRateLimit', () => {
  it('allows traffic under the limit', async () => {
    const app = appWith(apiRateLimit);

    for (let i = 0; i < 5; i++) {
      const response = await request(app).get('/');
      expect(response.status).toBe(200);
    }
  });

  it('answers 429 once the window limit is passed', async () => {
    const app = appWith(apiRateLimit);

    // The limit is 100 a minute; the 101st request is the first refused.
    for (let i = 0; i < 100; i++) {
      await request(app).get('/');
    }

    const refused = await request(app).get('/');

    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'Too many requests' });
  });

  it('tells the caller when to retry', async () => {
    const app = appWith(apiRateLimit);

    for (let i = 0; i < 100; i++) {
      await request(app).get('/');
    }
    const refused = await request(app).get('/');

    // Without this a client has no way to back off other than by guessing.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('advertises the policy in the standard headers rather than the legacy ones', async () => {
    const response = await request(appWith(apiRateLimit)).get('/');

    expect(response.headers['ratelimit-policy']).toContain('100');
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('authRateLimit', () => {
  it('is tighter than the general API limit', async () => {
    const app = appWith(authRateLimit);

    for (let i = 0; i < 20; i++) {
      expect((await request(app).get('/')).status).toBe(200);
    }

    expect((await request(app).get('/')).status).toBe(429);
  });
});

describe('the key a caller is counted against', () => {
  it('cannot be chosen by the caller when no proxy is trusted', async () => {
    // With `trust proxy` at 0, a forwarded header is not consulted, so varying
    // it cannot buy a fresh bucket. If it could, the limit would be advisory.
    const app = appWith(apiRateLimit);

    for (let i = 0; i < 100; i++) {
      await request(app).get('/');
    }

    const refused = await request(app).get('/').set('X-Forwarded-For', '203.0.113.9');

    expect(refused.status).toBe(429);
  });
});
