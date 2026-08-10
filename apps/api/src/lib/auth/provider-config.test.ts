import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// env() memoises its result, so every case needs the module evaluated again
// against the environment that case has just set up.
async function loadEnv() {
  vi.resetModules();
  return import('../env.js');
}

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

describe('AUTH_PROVIDER', () => {
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

  it('starts without GitHub client credentials under the token provider', async () => {
    process.env.AUTH_PROVIDER = 'token';

    // The whole point of the change: a fresh clone runs without first
    // registering a GitHub OAuth application.
    const { env } = await loadEnv();
    expect(env().AUTH_PROVIDER).toBe('token');
  });

  it('starts without client credentials under the oauth provider, and says so', async () => {
    process.env.AUTH_PROVIDER = 'oauth';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Both methods now live in one process, so a missing OAuth application
    // disables that one method rather than the whole API. Silence would be the
    // wrong answer for a team deployment, hence the warning.
    const { env } = await loadEnv();
    expect(env().AUTH_PROVIDER).toBe('oauth');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GITHUB_CLIENT_ID'));

    warn.mockRestore();
  });

  it('defaults to oauth when unset, so a deployment cannot fall into single-user mode', async () => {
    process.env.GITHUB_CLIENT_ID = 'id';
    process.env.GITHUB_CLIENT_SECRET = 'secret';

    const { env } = await loadEnv();
    expect(env().AUTH_PROVIDER).toBe('oauth');
  });

  it('rejects an unrecognised provider instead of silently choosing one', async () => {
    process.env.AUTH_PROVIDER = 'gh';

    const { env } = await loadEnv();
    expect(() => env()).toThrowError(/AUTH_PROVIDER must be "oauth" or "token"/);
  });

  it('keeps remote access off unless it is explicitly enabled', async () => {
    process.env.AUTH_PROVIDER = 'token';

    const { env } = await loadEnv();
    expect(env().AUTH_TOKEN_ALLOW_REMOTE).toBe(false);
  });

  it('only enables remote access for the exact string "true"', async () => {
    process.env.AUTH_PROVIDER = 'token';
    // A truthy-looking value must not open this up; the failure is silent and
    // the consequence is the operator's repository access.
    process.env.AUTH_TOKEN_ALLOW_REMOTE = '1';

    const { env } = await loadEnv();
    expect(env().AUTH_TOKEN_ALLOW_REMOTE).toBe(false);
  });

  it('enables remote access when the operator opts in', async () => {
    process.env.AUTH_PROVIDER = 'token';
    process.env.AUTH_TOKEN_ALLOW_REMOTE = 'true';

    const { env } = await loadEnv();
    expect(env().AUTH_TOKEN_ALLOW_REMOTE).toBe(true);
  });
});
