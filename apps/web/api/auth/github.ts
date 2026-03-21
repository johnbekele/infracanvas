// GET /api/auth/github - Redirect to GitHub OAuth
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'crypto';
import { serialize } from 'cookie';
import { getEnv } from '../_lib/env';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const SCOPES = ['repo', 'read:user', 'user:email'];

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const env = getEnv();
  const state = randomBytes(32).toString('hex');

  // Determine callback URL
  const baseUrl = env.APP_URL.replace(/\/$/, '');
  const callbackUrl = `${baseUrl}/api/auth/github/callback`;

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: SCOPES.join(' '),
    state,
    allow_signup: 'true',
  });

  // Set state cookie
  res.setHeader(
    'Set-Cookie',
    serialize('github_oauth_state', state, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    })
  );

  res.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
}
