// JWT session management using jose library
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from './env.js';

/**
 * How long a token is good for, and how long a sign-in lasts.
 *
 * The token is short so that revoking a session takes effect quickly without
 * checking the database on every request; the session is long so that analysing
 * a large repository does not end with being logged out. The refresh window is
 * where the two meet: inside it, the row is consulted and both are extended.
 */
export const SESSION_DURATION_MS = 60 * 60 * 1000;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 15 * 60 * 1000;

export interface SessionPayload extends JWTPayload {
  userId: string;
  githubId: number;
  githubUsername: string;
  /** The `sessions` row backing this token. Absent in tokens issued before it existed. */
  sessionId?: string;
}

export interface SessionClaims {
  userId: string;
  githubId: number;
  githubUsername: string;
  sessionId?: string;
}

/**
 * Create a signed JWT session token
 */
export async function createSessionToken(payload: SessionClaims): Promise<string> {
  const secret = new TextEncoder().encode(env().JWT_SECRET);

  const token = await new SignJWT({
    userId: payload.userId,
    githubId: payload.githubId,
    githubUsername: payload.githubUsername,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(new Date(Date.now() + SESSION_DURATION_MS))
    .setIssuer('infracanvas')
    .setAudience('infracanvas-web')
    .sign(secret);

  return token;
}

/**
 * Verify and decode a session token
 * Returns null if absent, invalid, or expired
 */
export async function verifySessionToken(
  token: string | null | undefined
): Promise<SessionPayload | null> {
  if (!token) {
    return null;
  }

  try {
    const secret = new TextEncoder().encode(env().JWT_SECRET);

    const { payload } = await jwtVerify(token, secret, {
      issuer: 'infracanvas',
      audience: 'infracanvas-web',
    });

    // Validate required fields
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.githubId !== 'number' ||
      typeof payload.githubUsername !== 'string'
    ) {
      return null;
    }

    if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') {
      return null;
    }

    return payload as SessionPayload;
  } catch {
    return null;
  }
}

/** Whether a verified token is close enough to expiry to be worth renewing. */
export function isCloseToExpiry(payload: SessionPayload): boolean {
  if (!payload.exp) return false;
  return payload.exp * 1000 - Date.now() < REFRESH_THRESHOLD_MS;
}

/**
 * Check if a token should be refreshed
 * Returns true if token expires within the refresh threshold
 */
export async function shouldRefreshToken(token: string): Promise<boolean> {
  const payload = await verifySessionToken(token);
  return payload ? isCloseToExpiry(payload) : false;
}

/**
 * Refresh a session token if it's close to expiry
 * Returns new token if refreshed, null if token is invalid
 */
export async function refreshSessionToken(token: string): Promise<string | null> {
  const payload = await verifySessionToken(token);

  if (!payload) {
    return null;
  }

  return createSessionToken({
    userId: payload.userId,
    githubId: payload.githubId,
    githubUsername: payload.githubUsername,
    sessionId: payload.sessionId,
  });
}
