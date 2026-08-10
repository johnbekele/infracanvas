import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

const BASE = {
  DATABASE_URL: 'postgres://localhost:5432/test?sslmode=disable',
  ENCRYPTION_KEY: '0'.repeat(64),
  JWT_SECRET: 'test-secret',
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:3001',
};

const MANAGED = [
  ...Object.keys(BASE),
  'AUTH_PROVIDER',
  'AUTH_TOKEN_ALLOW_REMOTE',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
];

/** env() memoises, so each case needs the module graph evaluated again. */
async function loadMethods() {
  const { vi } = await import('vitest');
  vi.resetModules();
  return import('./methods.js');
}

function requestFrom(address: string): Request {
  return { socket: { remoteAddress: address }, headers: {} } as unknown as Request;
}

const LOCAL = () => requestFrom('127.0.0.1');
const REMOTE = () => requestFrom('203.0.113.5');

describe('availableMethods', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    Object.assign(process.env, BASE);
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('reports oauth as unavailable when no client id is configured', async () => {
    const { availableMethods } = await loadMethods();

    const oauth = availableMethods(LOCAL()).methods.find((method) => method.id === 'oauth');

    expect(oauth?.available).toBe(false);
    expect(oauth?.reason).toMatch(/GITHUB_CLIENT_ID/);
  });

  it('reports oauth as available once an application is configured', async () => {
    process.env.GITHUB_CLIENT_ID = 'id';
    process.env.GITHUB_CLIENT_SECRET = 'secret';
    const { availableMethods } = await loadMethods();

    const oauth = availableMethods(LOCAL()).methods.find((method) => method.id === 'oauth');

    expect(oauth?.available).toBe(true);
    expect(oauth?.reason).toBeUndefined();
  });

  it('reports the token method as unavailable for a remote caller', async () => {
    const { availableMethods } = await loadMethods();

    const token = availableMethods(REMOTE()).methods.find((method) => method.id === 'token');

    expect(token?.available).toBe(false);
    expect(token?.reason).toMatch(/AUTH_TOKEN_ALLOW_REMOTE/);
  });

  it('offers the token method to a remote caller once the operator opts in', async () => {
    process.env.AUTH_TOKEN_ALLOW_REMOTE = 'true';
    const { availableMethods } = await loadMethods();

    const token = availableMethods(REMOTE()).methods.find((method) => method.id === 'token');

    expect(token?.available).toBe(true);
  });
});

describe('chooseMethod', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    Object.assign(process.env, BASE);
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the requested method rather than the configured default', async () => {
    process.env.AUTH_PROVIDER = 'token';
    process.env.GITHUB_CLIENT_ID = 'id';
    process.env.GITHUB_CLIENT_SECRET = 'secret';
    const { chooseMethod } = await loadMethods();

    // The exact case that was impossible before: credentials configured, the
    // variable still saying token, and the user asking for OAuth.
    expect(chooseMethod(LOCAL(), 'oauth')).toEqual({ ok: true, method: 'oauth' });
  });

  it('falls back to the configured provider when no method is requested', async () => {
    process.env.AUTH_PROVIDER = 'token';
    process.env.GITHUB_CLIENT_ID = 'id';
    process.env.GITHUB_CLIENT_SECRET = 'secret';
    const { chooseMethod } = await loadMethods();

    expect(chooseMethod(LOCAL(), undefined)).toEqual({ ok: true, method: 'token' });
  });

  it('refuses an unavailable method with a message rather than redirecting', async () => {
    const { chooseMethod } = await loadMethods();

    const choice = chooseMethod(REMOTE(), 'token');

    expect(choice.ok).toBe(false);
    if (!choice.ok) {
      expect(choice.status).toBe(403);
      expect(choice.error).toMatch(/only accepts requests from this machine/);
    }
  });

  it('refuses a method name it does not recognise', async () => {
    const { chooseMethod } = await loadMethods();

    const choice = chooseMethod(LOCAL(), 'saml');

    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.status).toBe(400);
  });

  it('falls through to a usable method when the configured one cannot work', async () => {
    process.env.AUTH_PROVIDER = 'oauth';
    const { chooseMethod } = await loadMethods();

    // No OAuth application configured, so a local caller gets the method that
    // can actually complete instead of a redirect into a broken flow.
    expect(chooseMethod(LOCAL(), undefined)).toEqual({ ok: true, method: 'token' });
  });

  it('explains itself when no method can work at all', async () => {
    process.env.AUTH_PROVIDER = 'oauth';
    const { chooseMethod } = await loadMethods();

    const choice = chooseMethod(REMOTE(), undefined);

    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.status).toBe(503);
  });
});
