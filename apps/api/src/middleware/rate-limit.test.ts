import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { apiRateLimit, copilotTurnRateLimit, signInRateLimit } from './rate-limit.js';

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
    expect(refused.body.error).toBe('Too many requests');
  });

  it('tells the caller when to retry', async () => {
    const app = appWith(apiRateLimit);

    for (let i = 0; i < 100; i++) {
      await request(app).get('/');
    }
    const refused = await request(app).get('/');

    // Without this a client has no way to back off other than by guessing.
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // In the body as well as the header, because that is what a browser client
    // reads without being taught to look anywhere else.
    expect(refused.body.retryAfter).toBe(60);
  });

  it('advertises the policy in the standard headers rather than the legacy ones', async () => {
    const response = await request(appWith(apiRateLimit)).get('/');

    expect(response.headers['ratelimit-policy']).toContain('100');
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('signInRateLimit', () => {
  it('is tighter than the general API limit', async () => {
    const app = appWith(signInRateLimit);

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

describe('copilotTurnRateLimit', () => {
  /** The limiter behind a session, as the copilot router mounts it. */
  function appAs(userId: string | null) {
    const app = express();
    app.set('trust proxy', 0);
    app.get(
      '/',
      (req, _res, next) => {
        if (userId !== null) req.session = { userId, sessionId: 'test' } as never;
        next();
      },
      copilotTurnRateLimit,
      (_req, res) => {
        res.json({ ok: true });
      }
    );
    return app;
  }

  it('limits turns per user rather than per address', async () => {
    // Two users behind one address: spending one budget must not spend the
    // other's, which is the whole reason this limiter exists.
    const mine = appAs('11111111-1111-4111-8111-111111111111');
    const theirs = appAs('22222222-2222-4222-8222-222222222222');

    for (let i = 0; i < 40; i++) {
      expect((await request(mine).get('/')).status).toBe(200);
    }

    expect((await request(mine).get('/')).status).toBe(429);
    expect((await request(theirs).get('/')).status).toBe(200);
  });

  it('refuses with the same body shape as the other limiters', async () => {
    const app = appAs('33333333-3333-4333-8333-333333333333');
    for (let i = 0; i < 40; i++) await request(app).get('/');

    const refused = await request(app).get('/');

    expect(refused.body).toEqual({ error: 'Too many requests', retryAfter: 3600 });
  });

  it('falls back to the ip key for a request with no session', async () => {
    // Not `req.ip`: this module already explains that a hand-rolled key gives
    // every IPv6 client a whole /64 of its own.
    const app = appAs(null);

    for (let i = 0; i < 40; i++) {
      expect((await request(app).get('/')).status).toBe(200);
    }

    expect((await request(app).get('/')).status).toBe(429);
  });
});
