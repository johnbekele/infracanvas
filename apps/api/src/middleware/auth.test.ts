import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { optionalAuth, requireAuth, SESSION_COOKIE_NAME } from './auth.js';
import { createSessionToken } from '../lib/jwt.js';
import { findLiveSession, touchSession } from '../lib/db/sessions.js';

// The session row is the only part of authentication that needs a database.
// Mocking it keeps these tests runnable on a laptop with nothing installed,
// which is the same reason the integration tests live in a separate config.
vi.mock('../lib/db/sessions.js', () => ({
  findLiveSession: vi.fn(),
  touchSession: vi.fn(),
}));

const liveSession = vi.mocked(findLiveSession);
const extendSession = vi.mocked(touchSession);

const SESSION_ROW = {
  id: 's-1',
  userId: 'u-1',
  issuedAt: new Date(),
  lastSeenAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null,
  authMethod: 'token' as const,
  tokenOrigin: 'gh-cli',
  userAgent: null,
};

beforeEach(() => {
  liveSession.mockReset();
  extendSession.mockReset();
  liveSession.mockResolvedValue(SESSION_ROW);
  extendSession.mockResolvedValue(true);
});

// Signing a token loads the validated environment, which is all-or-nothing.
beforeAll(() => {
  process.env.JWT_SECRET ??= 'a-test-secret-that-is-long-enough-to-pass';
  process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
  process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
  process.env.APP_URL ??= 'http://localhost:5173';
  process.env.API_URL ??= 'http://localhost:3001';
  // Validated but never connected to; these tests touch no database.
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5433/test?sslmode=disable';
});

function requestWith(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

interface Recorded {
  res: Response;
  status: number | null;
  body: unknown;
  cookies: { name: string; value: string }[];
}

function recordingResponse(): Recorded {
  const recorded: Recorded = {
    status: null,
    body: null,
    cookies: [],
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
    cookie(name: string, value: string) {
      recorded.cookies.push({ name, value });
      return this;
    },
    setHeader: () => undefined,
  } as unknown as Response;
  return recorded;
}

async function validToken(): Promise<string> {
  return createSessionToken({ userId: 'u-1', githubId: 7, githubUsername: 'johnbekele' });
}

// A well-formed JWT signed with the wrong key: structurally valid, so it only
// fails once the signature is actually checked.
const FORGED_TOKEN = [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ userId: 'u-1', githubId: 7, githubUsername: 'attacker' })).toString(
    'base64url'
  ),
  'not-a-real-signature',
].join('.');

describe('optionalAuth', () => {
  it('attaches the session for a valid bearer token', async () => {
    const req = requestWith({ authorization: `Bearer ${await validToken()}` });
    const next = vi.fn();

    await optionalAuth(req, recordingResponse().res, next);

    expect(req.session?.githubUsername).toBe('johnbekele');
    expect(next).toHaveBeenCalledOnce();
  });

  it('attaches the session for a valid cookie', async () => {
    const req = requestWith({ cookie: `${SESSION_COOKIE_NAME}=${await validToken()}` });

    await optionalAuth(req, recordingResponse().res, vi.fn());

    expect(req.session?.githubUsername).toBe('johnbekele');
  });

  it('continues anonymously when no token is present', async () => {
    const req = requestWith({});
    const next = vi.fn();

    await optionalAuth(req, recordingResponse().res, next);

    expect(req.session).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('continues anonymously rather than trusting an unparseable token', async () => {
    const req = requestWith({ authorization: 'Bearer not-a-jwt' });
    const next = vi.fn();

    await optionalAuth(req, recordingResponse().res, next);

    expect(req.session).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('ignores a token signed with another secret', async () => {
    const req = requestWith({ authorization: `Bearer ${FORGED_TOKEN}` });

    await optionalAuth(req, recordingResponse().res, vi.fn());

    expect(req.session).toBeUndefined();
  });

  it('ignores an empty bearer token', async () => {
    const req = requestWith({ authorization: 'Bearer ' });

    await optionalAuth(req, recordingResponse().res, vi.fn());

    expect(req.session).toBeUndefined();
  });
});

describe('requireAuth', () => {
  it('rejects a request with no token', async () => {
    const recorded = recordingResponse();
    const next = vi.fn();

    await requireAuth(requestWith({}), recorded.res, next);

    expect(recorded.status).toBe(401);
    expect(recorded.body).toEqual({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a token signed with another secret', async () => {
    const recorded = recordingResponse();
    const next = vi.fn();

    await requireAuth(requestWith({ authorization: `Bearer ${FORGED_TOKEN}` }), recorded.res, next);

    expect(recorded.status).toBe(401);
    expect(recorded.body).toEqual({ error: 'Invalid or expired session' });
    expect(next).not.toHaveBeenCalled();
  });

  it('admits a valid token', async () => {
    const req = requestWith({ authorization: `Bearer ${await validToken()}` });
    const recorded = recordingResponse();
    const next = vi.fn();

    await requireAuth(req, recorded.res, next);

    expect(recorded.status).toBeNull();
    expect(req.session?.userId).toBe('u-1');
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('session rows', () => {
  async function tokenForSession(): Promise<string> {
    return createSessionToken({
      userId: 'u-1',
      githubId: 7,
      githubUsername: 'johnbekele',
      sessionId: 's-1',
    });
  }

  it('rejects a session that has been revoked', async () => {
    // The signature is still valid: revocation is the only thing saying no, and
    // before the sessions table there was nothing to say it with.
    liveSession.mockResolvedValue(null);

    const recorded = recordingResponse();
    const next = vi.fn();

    await requireAuth(
      requestWith({ authorization: `Bearer ${await tokenForSession()}` }),
      recorded.res,
      next
    );

    expect(recorded.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a session whose row has been deleted', async () => {
    liveSession.mockResolvedValue(null);
    const req = requestWith({ authorization: `Bearer ${await tokenForSession()}` });

    await optionalAuth(req, recordingResponse().res, vi.fn());

    expect(req.session).toBeUndefined();
  });

  it('refuses rather than admits when the session lookup fails', async () => {
    liveSession.mockRejectedValue(new Error('connection refused'));

    const recorded = recordingResponse();
    await requireAuth(
      requestWith({ authorization: `Bearer ${await tokenForSession()}` }),
      recorded.res,
      vi.fn()
    );

    expect(recorded.status).toBe(401);
  });

  it('admits a token that predates the sessions table without a lookup', async () => {
    const req = requestWith({ authorization: `Bearer ${await validToken()}` });
    const next = vi.fn();

    await requireAuth(req, recordingResponse().res, next);

    expect(liveSession).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('rewrites the session cookie when the token is close to expiry', async () => {
    // Freeze time inside the refresh window rather than minting a nearly-expired
    // token, so the test says what it means.
    vi.useFakeTimers();
    const token = await tokenForSession();
    vi.setSystemTime(new Date(Date.now() + 50 * 60 * 1000));

    const recorded = recordingResponse();
    await requireAuth(requestWith({ authorization: `Bearer ${token}` }), recorded.res, vi.fn());
    vi.useRealTimers();

    const cookie = recorded.cookies.find((entry) => entry.name === SESSION_COOKIE_NAME);
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.value).not.toBe(token);
    expect(extendSession).toHaveBeenCalledWith('s-1', expect.any(Date));
  });

  it('leaves the cookie alone for a token nowhere near expiry', async () => {
    const recorded = recordingResponse();

    await requireAuth(
      requestWith({ authorization: `Bearer ${await tokenForSession()}` }),
      recorded.res,
      vi.fn()
    );

    expect(recorded.cookies).toHaveLength(0);
    expect(extendSession).not.toHaveBeenCalled();
  });
});
