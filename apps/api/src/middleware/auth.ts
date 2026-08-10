// Authentication middleware
import { type Request, type Response, type NextFunction } from 'express';
import { parse as parseCookie } from 'cookie';
import {
  createSessionToken,
  isCloseToExpiry,
  verifySessionToken,
  SESSION_DURATION_MS,
  SESSION_MAX_AGE_MS,
  type SessionPayload,
} from '../lib/jwt.js';
import { findLiveSession, touchSession } from '../lib/db/sessions.js';
import { SESSION_COOKIE_NAME, setSessionCookie } from '../lib/auth/cookie.js';
import { logError } from '../lib/log.js';

// Extend Express Request type to include session.
// Express ships its types as a global namespace, so augmenting it is the only
// supported mechanism here.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

/**
 * Extract session token from request
 * Checks both cookie and Authorization header
 */
function extractToken(req: Request): string | null {
  // Check cookie first
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookie(cookieHeader);
    if (cookies[SESSION_COOKIE_NAME]) {
      return cookies[SESSION_COOKIE_NAME];
    }
  }

  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Whether the sign-in behind a token is still live.
 *
 * Checked on every authenticated request rather than only when the token is
 * near expiry. A signature cannot be withdrawn, so without this lookup logging
 * out would merely stop the browser from sending the cookie: anyone holding a
 * copy would keep access until the token expired on its own. It is a primary
 * key lookup, which is the cheapest question the database can be asked.
 *
 * Tokens with no `sessionId` predate the sessions table and are trusted on
 * their signature alone, so an existing sign-in is not invalidated by a deploy.
 */
async function sessionIsLive(payload: SessionPayload): Promise<boolean> {
  if (!payload.sessionId) return true;

  try {
    return (await findLiveSession(payload.sessionId)) !== null;
  } catch (error) {
    // A database outage should not silently turn into an open door.
    logError('Session lookup failed', error);
    return false;
  }
}

/**
 * Extend a session that is being used, and write the new cookie.
 *
 * The old code computed a refreshed token and set it on an `X-Refreshed-Token`
 * header that nothing read, so the cookie was never rewritten and the refresh
 * path had never once extended a session. Anyone analysing a large repository
 * could be logged out mid-way.
 */
async function refreshSession(res: Response, payload: SessionPayload): Promise<void> {
  try {
    if (payload.sessionId) {
      const extended = await touchSession(
        payload.sessionId,
        new Date(Date.now() + SESSION_MAX_AGE_MS)
      );
      if (!extended) return;
    }

    const token = await createSessionToken({
      userId: payload.userId,
      githubId: payload.githubId,
      githubUsername: payload.githubUsername,
      sessionId: payload.sessionId,
    });

    setSessionCookie(res, token, SESSION_DURATION_MS);
    // Retained for API clients that hold the token themselves rather than
    // relying on a cookie jar.
    res.setHeader('X-Refreshed-Token', token);
  } catch (error) {
    // A failed refresh is not a failed request: the current token is still
    // valid, and the next request will try again.
    logError('Session refresh failed', error);
  }
}

/**
 * Require authentication middleware
 * Returns 401 if not authenticated
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const session = await verifySessionToken(token);

  if (!session || !(await sessionIsLive(session))) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.session = session;

  if (isCloseToExpiry(session)) {
    await refreshSession(res, session);
  }

  next();
}

/**
 * Optional authentication middleware
 * Attaches session if available but doesn't require it
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // The absent case is handled by verifySessionToken rather than a branch here,
  // so nothing the caller supplies decides whether the signature is checked.
  const session = await verifySessionToken(extractToken(req));

  if (session && (await sessionIsLive(session))) {
    req.session = session;
  }

  next();
}

export { SESSION_COOKIE_NAME };
