// Refuses a state-changing request whose CSRF header does not match the cookie.
// Safe methods pass untouched: a GET that changes state is a defect this
// middleware cannot fix and must not pretend to.
import { type Request, type Response, type NextFunction } from 'express';
import { parse as parseCookie } from 'cookie';
import { CSRF_COOKIE, SESSION_COOKIE } from '../lib/auth/cookie.js';
import { csrfTokenMatches } from '../lib/auth/csrf.js';
import { envSafe } from '../lib/env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_HEADER = 'x-csrf-token';

function allowedOrigins(): string[] {
  const config = envSafe();
  return [
    config.APP_URL,
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:4173',
  ].filter(Boolean) as string[];
}

function sessionIdFromRequest(req: Request): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = parseCookie(cookieHeader);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      sessionId?: unknown;
    };
    return typeof payload.sessionId === 'string' ? payload.sessionId : null;
  } catch {
    return null;
  }
}

function headerToken(req: Request): string | undefined {
  const raw = req.headers[CSRF_HEADER];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

/**
 * The OAuth callback has no session yet and is protected by its own state
 * parameter. Everything else that changes state goes through this check.
 */
function isAuthCallback(req: Request): boolean {
  return req.path === '/auth/github/callback' || req.path === '/github/callback';
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method.toUpperCase()) || isAuthCallback(req)) {
    next();
    return;
  }

  const presented = headerToken(req);
  if (!presented) {
    res.status(403).json({ error: 'csrf_token_missing', code: 'csrf_token_missing' });
    return;
  }

  const sessionId = sessionIdFromRequest(req);
  const cookieHeader = req.headers.cookie;
  const csrfCookie = cookieHeader ? parseCookie(cookieHeader)[CSRF_COOKIE] : undefined;

  // Double-submit: the header must echo the cookie. Binding: the value must be
  // the HMAC of this request's session id, so a token from another session fails.
  if (
    !sessionId ||
    !csrfCookie ||
    presented !== csrfCookie ||
    !csrfTokenMatches(sessionId, presented)
  ) {
    res.status(403).json({ error: 'csrf_token_invalid', code: 'csrf_token_invalid' });
    return;
  }

  const origin = req.headers.origin;
  if (origin && !allowedOrigins().includes(origin)) {
    res.status(403).json({ error: 'origin_not_allowed', code: 'origin_not_allowed' });
    return;
  }

  next();
}
