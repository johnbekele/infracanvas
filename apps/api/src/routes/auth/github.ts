// GitHub OAuth flow - initiate authorization
import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { env } from '../../lib/env.js';

const router = Router();

// GitHub OAuth URLs
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

// Required scopes for InfraCanvas
const SCOPES = ['repo', 'read:user', 'user:email'];

/**
 * GET /auth/github
 * Redirects to GitHub OAuth authorization page
 */
router.get('/', (_req: Request, res: Response) => {
  const config = env();

  // Generate CSRF state token
  const state = randomBytes(32).toString('hex');

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID,
    redirect_uri: `${config.API_URL}/auth/github/callback`,
    scope: SCOPES.join(' '),
    state,
    allow_signup: 'true',
  });

  const authUrl = `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;

  // Store state in cookie for verification on callback
  res.cookie('github_oauth_state', state, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000, // 10 minutes
    path: '/',
  });

  res.redirect(authUrl);
});

export default router;
