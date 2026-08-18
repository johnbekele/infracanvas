// The session cookie, written the same way everywhere it is written.
//
// Sign-in, refresh, and logout each set this cookie. When they set it with
// different attributes the browser keeps both, and the stale one wins on the
// next request -- which is the sort of bug that looks like a random logout.
//
// SameSite=None because the browser app and this API are different registrable
// domains in every deployment except local development, and a Lax cookie is
// withheld from exactly the cross-site fetch the app makes. None requires
// Secure, so the cookie is https-only outside development.
import type { CookieOptions, Response } from 'express';
import { env } from '../env.js';
import { mintCsrfToken } from './csrf.js';

export const SESSION_COOKIE = 'infracanvas_session';
export const CSRF_COOKIE = 'infracanvas_csrf';

/** Existing call sites still import this name. */
export const SESSION_COOKIE_NAME = SESSION_COOKIE;

function crossOriginCookieFlags(): Pick<CookieOptions, 'secure' | 'sameSite'> {
  // Development shares an origin via the Vite proxy, so Lax is enough, and a
  // Secure cookie would be dropped by the browser over plain http locally.
  const isDev = env().NODE_ENV === 'development';
  return {
    secure: !isDev,
    sameSite: isDev ? 'lax' : 'none',
  };
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    path: '/',
    ...crossOriginCookieFlags(),
  };
}

/** Readable by script: the client must echo it in a header. */
export function csrfCookieOptions(): CookieOptions {
  return {
    httpOnly: false,
    path: '/',
    ...crossOriginCookieFlags(),
  };
}

/** Pull the session id claim out of a JWT without verifying the signature. */
function sessionIdFromToken(token: string): string | null {
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

export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: maxAgeMs });

  // Refresh goes through this helper too, so a rotated session never leaves a
  // CSRF cookie minted for the previous id.
  const sessionId = sessionIdFromToken(token);
  if (sessionId) {
    res.cookie(CSRF_COOKIE, mintCsrfToken(sessionId), {
      ...csrfCookieOptions(),
      maxAge: maxAgeMs,
    });
  }
}

export function clearSessionCookie(res: Response): void {
  res.cookie(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
  res.cookie(CSRF_COOKIE, '', { ...csrfCookieOptions(), maxAge: 0 });
}
