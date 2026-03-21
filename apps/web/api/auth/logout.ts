// POST /api/auth/logout - Clear session
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { serialize } from 'cookie';
import { getEnv } from '../_lib/env';
import { SESSION_COOKIE_NAME, setCorsHeaders } from '../_lib/auth';

export default function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const env = getEnv();

  res.setHeader(
    'Set-Cookie',
    serialize(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    })
  );

  res.json({ success: true });
}
