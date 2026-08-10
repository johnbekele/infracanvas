// The session cookie, written the same way everywhere it is written.
//
// Sign-in, refresh, and logout each set this cookie. When they set it with
// different attributes the browser keeps both, and the stale one wins on the
// next request -- which is the sort of bug that looks like a random logout.
import type { Response } from 'express';
import { env } from '../env.js';

export const SESSION_COOKIE_NAME = 'infracanvas_session';

export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  setSessionCookie(res, '', 0);
}
