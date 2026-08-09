// JWT session management using jose library
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from './env.js';

// Session duration: 1 hour
const SESSION_DURATION = '1h';
// Refresh threshold: 15 minutes before expiry
const REFRESH_THRESHOLD = 15 * 60 * 1000; // 15 minutes in ms

export interface SessionPayload extends JWTPayload {
  userId: string;
  githubId: number;
  githubUsername: string;
}

/**
 * Create a signed JWT session token
 */
export async function createSessionToken(payload: {
  userId: string;
  githubId: number;
  githubUsername: string;
}): Promise<string> {
  const secret = new TextEncoder().encode(env().JWT_SECRET);

  const token = await new SignJWT({
    userId: payload.userId,
    githubId: payload.githubId,
    githubUsername: payload.githubUsername,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_DURATION)
    .setIssuer('infracanvas')
    .setAudience('infracanvas-web')
    .sign(secret);

  return token;
}

/**
 * Verify and decode a session token
 * Returns null if invalid or expired
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
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

    return payload as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Check if a token should be refreshed
 * Returns true if token expires within REFRESH_THRESHOLD
 */
export async function shouldRefreshToken(token: string): Promise<boolean> {
  const payload = await verifySessionToken(token);

  if (!payload || !payload.exp) {
    return false;
  }

  const expiresAt = payload.exp * 1000; // Convert to milliseconds
  const now = Date.now();

  return expiresAt - now < REFRESH_THRESHOLD;
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

  // Create a new token with the same payload
  return createSessionToken({
    userId: payload.userId,
    githubId: payload.githubId,
    githubUsername: payload.githubUsername,
  });
}
