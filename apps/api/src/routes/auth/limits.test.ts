/**
 * Which auth endpoints are held to the sign-in ceiling.
 *
 * The whole router used to sit behind it, so twenty page views spent the
 * fifteen-minute budget on status checks and the browser was told it had no
 * session. These tests exist because that failure is invisible in a unit test
 * of the limiter itself: both limiters worked exactly as written, and the bug
 * was in which requests each one counted.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

beforeAll(() => {
  process.env.DATABASE_URL ??= 'postgres://localhost:5433/unused';
  process.env.JWT_SECRET ??= 'test-secret-value-for-signing-tokens-only';
  process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
  process.env.APP_URL ??= 'http://localhost:5173';
  process.env.API_URL ??= 'http://localhost:3001';
  process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
});

/**
 * The real router, mounted the way `index.ts` mounts it.
 *
 * The limiters are module singletons holding one counter store, so tests would
 * otherwise inherit each other's totals. Trusting a single hop and giving each
 * test its own address puts every test in its own bucket.
 */
async function authApp() {
  const { default: authRoutes } = await import('./index.js');
  const app = express();
  app.set('trust proxy', 1);
  app.use('/auth', authRoutes);
  return app;
}

let nextAddress = 0;

/** A caller nothing else in this file shares a rate-limit bucket with. */
function caller(app: express.Express) {
  nextAddress += 1;
  const address = `203.0.113.${nextAddress}`;
  return (path: string) => request(app).get(path).set('X-Forwarded-For', address);
}

describe('the sign-in ceiling', () => {
  it('does not apply to reading your own status', async () => {
    const get = caller(await authApp());

    // Well past the twenty-request sign-in budget. A person opening pages in a
    // single sitting reaches this without doing anything unusual.
    for (let i = 0; i < 40; i++) {
      expect((await get('/auth/status')).status).toBe(200);
    }
  });

  it('does not apply to asking which methods exist', async () => {
    const get = caller(await authApp());

    for (let i = 0; i < 40; i++) {
      expect((await get('/auth/methods')).status).toBe(200);
    }
  });

  it('still applies to the sign-in endpoint', async () => {
    const get = caller(await authApp());

    for (let i = 0; i < 20; i++) {
      // Any answer but 429: a redirect, or a refusal because the method is
      // unavailable here. What matters is that the limiter let it through.
      expect((await get('/auth/github?method=oauth')).status).not.toBe(429);
    }

    expect((await get('/auth/github?method=oauth')).status).toBe(429);
  });

  it('counts the callback against the same budget as the sign-in it completes', async () => {
    const get = caller(await authApp());

    for (let i = 0; i < 20; i++) {
      await get('/auth/github?method=oauth');
    }

    // Otherwise an attacker replays codes against the callback all day while
    // never touching the endpoint that is actually limited.
    expect((await get('/auth/github/callback')).status).toBe(429);
  });

  it('reports how long to wait rather than only refusing', async () => {
    const get = caller(await authApp());

    for (let i = 0; i < 20; i++) {
      await get('/auth/github?method=oauth');
    }
    const refused = await get('/auth/github?method=oauth');

    expect(refused.body).toEqual({ error: 'Too many requests', retryAfter: 900 });
  });
});
