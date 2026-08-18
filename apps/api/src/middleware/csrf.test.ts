import { describe, expect, it, beforeAll, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireCsrf } from './csrf.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../lib/auth/cookie.js';
import { mintCsrfToken } from '../lib/auth/csrf.js';
import { createSessionToken } from '../lib/jwt.js';

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

interface Recorded {
  res: Response;
  status: number | null;
  body: unknown;
}

function recordingResponse(): Recorded {
  const recorded: Recorded = {
    status: null,
    body: null,
    res: null as unknown as Response,
  };
  recorded.res = {
    status(code: number) {
      recorded.status = code;
      return this;
    },
    json(payload: unknown) {
      recorded.body = payload;
      return this;
    },
  } as unknown as Response;
  return recorded;
}

async function sessionCookie(sessionId: string): Promise<string> {
  const token = await createSessionToken({
    userId: 'u-1',
    githubId: 7,
    githubUsername: 'johnbekele',
    sessionId,
  });
  return `${SESSION_COOKIE}=${token}`;
}

function requestWith(partial: {
  method?: string;
  headers?: Record<string, string>;
  path?: string;
}): Request {
  return {
    method: partial.method ?? 'GET',
    path: partial.path ?? '/repositories',
    headers: partial.headers ?? {},
  } as unknown as Request;
}

describe('requireCsrf', () => {
  it('lets a safe method through', () => {
    const next = vi.fn();
    const recorded = recordingResponse();

    requireCsrf(requestWith({ method: 'GET' }), recorded.res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(recorded.status).toBeNull();
  });

  it('refuses a post with no header', async () => {
    const next = vi.fn();
    const recorded = recordingResponse();
    const csrf = mintCsrfToken('session-a');

    requireCsrf(
      requestWith({
        method: 'POST',
        headers: {
          cookie: `${await sessionCookie('session-a')}; ${CSRF_COOKIE}=${csrf}`,
        },
      }),
      recorded.res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(recorded.status).toBe(403);
    expect(recorded.body).toMatchObject({ code: 'csrf_token_missing' });
  });

  it('refuses a post whose token belongs to another session', async () => {
    const next = vi.fn();
    const recorded = recordingResponse();
    const foreign = mintCsrfToken('session-b');

    requireCsrf(
      requestWith({
        method: 'POST',
        headers: {
          cookie: `${await sessionCookie('session-a')}; ${CSRF_COOKIE}=${foreign}`,
          'x-csrf-token': foreign,
        },
      }),
      recorded.res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(recorded.status).toBe(403);
    expect(recorded.body).toMatchObject({ code: 'csrf_token_invalid' });
  });

  it('accepts a post with a valid token', async () => {
    const next = vi.fn();
    const recorded = recordingResponse();
    const csrf = mintCsrfToken('session-a');

    requireCsrf(
      requestWith({
        method: 'POST',
        headers: {
          cookie: `${await sessionCookie('session-a')}; ${CSRF_COOKIE}=${csrf}`,
          'x-csrf-token': csrf,
        },
      }),
      recorded.res,
      next
    );

    expect(next).toHaveBeenCalledOnce();
    expect(recorded.status).toBeNull();
  });

  it('refuses a disallowed origin even with a valid token', async () => {
    const next = vi.fn();
    const recorded = recordingResponse();
    const csrf = mintCsrfToken('session-a');

    requireCsrf(
      requestWith({
        method: 'POST',
        headers: {
          cookie: `${await sessionCookie('session-a')}; ${CSRF_COOKIE}=${csrf}`,
          'x-csrf-token': csrf,
          origin: 'https://evil.example',
        },
      }),
      recorded.res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(recorded.status).toBe(403);
    expect(recorded.body).toMatchObject({ code: 'origin_not_allowed' });
  });
});
