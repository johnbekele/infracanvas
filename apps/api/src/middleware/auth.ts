// Authentication middleware
import { type Request, type Response, type NextFunction } from 'express';
import { parse as parseCookie } from 'cookie';
import {
  verifySessionToken,
  type SessionPayload,
  shouldRefreshToken,
  refreshSessionToken,
} from '../lib/jwt.js';

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

const SESSION_COOKIE_NAME = 'infracanvas_session';

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

  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  // Attach session to request
  req.session = session;

  // Check if token should be refreshed
  const needsRefresh = await shouldRefreshToken(token);
  if (needsRefresh) {
    const newToken = await refreshSessionToken(token);
    if (newToken) {
      // Set refreshed token in response header
      res.setHeader('X-Refreshed-Token', newToken);
    }
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

  if (session) {
    req.session = session;
  }

  next();
}

export { SESSION_COOKIE_NAME };
