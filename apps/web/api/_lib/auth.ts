// Auth utilities for serverless functions
import { VercelRequest } from '@vercel/node';
import { parse as parseCookie } from 'cookie';
import { verifySessionToken, SessionPayload } from './jwt';

export const SESSION_COOKIE_NAME = 'infracanvas_session';

export async function getSession(req: VercelRequest): Promise<SessionPayload | null> {
  // Check cookie
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookie(cookieHeader);
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) {
      return verifySessionToken(token);
    }
  }

  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return verifySessionToken(authHeader.slice(7));
  }

  return null;
}

export function setCorsHeaders(res: { setHeader: (name: string, value: string) => void }, origin?: string) {
  const allowedOrigins = [
    process.env.VITE_APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    'http://localhost:5173',
  ].filter(Boolean);

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
