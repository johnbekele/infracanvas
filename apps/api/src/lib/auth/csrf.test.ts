import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import type { Response } from 'express';
import { mintCsrfToken, csrfTokenMatches } from './csrf.js';
import { CSRF_COOKIE, SESSION_COOKIE, clearSessionCookie, setSessionCookie } from './cookie.js';
import { createSessionToken } from '../jwt.js';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'a-test-secret-that-is-long-enough-to-pass';
  process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
  process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
  process.env.APP_URL ??= 'http://localhost:5173';
  process.env.API_URL ??= 'http://localhost:3001';
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5433/test?sslmode=disable';
  process.env.NODE_ENV ??= 'test';
});

describe('csrf tokens', () => {
  it('mints a token bound to the session', () => {
    const forA = mintCsrfToken('session-a');
    const forB = mintCsrfToken('session-b');

    expect(forA).not.toBe(forB);
    expect(csrfTokenMatches('session-a', forA)).toBe(true);
    expect(csrfTokenMatches('session-b', forA)).toBe(false);
    expect(csrfTokenMatches('session-a', forB)).toBe(false);
  });

  it('rejects a malformed token without throwing', () => {
    expect(csrfTokenMatches('session-a', '')).toBe(false);
    expect(csrfTokenMatches('session-a', 'short')).toBe(false);
    expect(csrfTokenMatches('session-a', '!!!not-base64url!!!')).toBe(false);
    expect(() => csrfTokenMatches('session-a', '')).not.toThrow();
    expect(() => csrfTokenMatches('session-a', '!!!not-base64url!!!')).not.toThrow();
  });

  it('compares in constant time', () => {
    const source = readFileSync(fileURLToPath(new URL('./csrf.ts', import.meta.url)), 'utf8');
    // Assert the comparison uses timingSafeEqual rather than ===.
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).not.toMatch(/expected\s*===\s*presented|presented\s*===\s*expected/);

    const token = mintCsrfToken('session-a');
    expect(csrfTokenMatches('session-a', token)).toBe(true);
    // Length-mismatched input must still be handled without throwing.
    expect(csrfTokenMatches('session-a', 'x')).toBe(false);
    expect(() => csrfTokenMatches('session-a', 'x')).not.toThrow();
  });

  it('sets both cookies on sign-in and clears both on sign-out', async () => {
    const token = await createSessionToken({
      userId: 'u-1',
      githubId: 7,
      githubUsername: 'johnbekele',
      sessionId: 'session-sign-in',
    });

    const cookies: { name: string; value: string }[] = [];
    const res = {
      cookie(name: string, value: string) {
        cookies.push({ name, value });
        return this;
      },
    } as unknown as Response;

    setSessionCookie(res, token, 60_000);

    const names = cookies.map((entry) => entry.name);
    expect(names).toContain(SESSION_COOKIE);
    expect(names).toContain(CSRF_COOKIE);
    expect(cookies.find((entry) => entry.name === CSRF_COOKIE)?.value).toBe(
      mintCsrfToken('session-sign-in')
    );

    cookies.length = 0;
    clearSessionCookie(res);

    expect(cookies.map((entry) => entry.name).sort()).toEqual([CSRF_COOKIE, SESSION_COOKIE].sort());
    expect(cookies.every((entry) => entry.value === '')).toBe(true);
  });
});
