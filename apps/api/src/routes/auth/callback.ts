// GitHub OAuth callback - exchange code for token
import { Router, type Request, type Response } from 'express';
import { parse as parseCookie } from 'cookie';
import { env } from '../../lib/env.js';
import { establishSession } from '../../lib/auth/session.js';
import { logError } from '../../lib/log.js';

const router = Router();

// GitHub OAuth URLs
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

/**
 * GET /auth/github/callback
 * Handles GitHub OAuth callback, exchanges code for token
 */
router.get('/', async (req: Request, res: Response) => {
  const config = env();

  const { code, state, error, error_description } = req.query;

  // Handle OAuth errors
  if (error) {
    const errorMsg = encodeURIComponent(
      (error_description as string) || (error as string) || 'Authentication failed'
    );
    res.redirect(`${config.APP_URL}/callback?error=${errorMsg}`);
    return;
  }

  // Validate required parameters
  if (!code || typeof code !== 'string') {
    res.redirect(`${config.APP_URL}/callback?error=Missing%20authorization%20code`);
    return;
  }

  // Verify CSRF state
  const cookieHeader = req.headers.cookie;
  let storedState: string | undefined;

  if (cookieHeader) {
    const cookies = parseCookie(cookieHeader);
    storedState = cookies.github_oauth_state;
  }

  if (!state || state !== storedState) {
    res.redirect(`${config.APP_URL}/callback?error=Invalid%20state%20parameter`);
    return;
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.GITHUB_CLIENT_ID,
        client_secret: config.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;

    if (tokenData.error || !tokenData.access_token) {
      const errorMsg = encodeURIComponent(
        tokenData.error_description || tokenData.error || 'Failed to get access token'
      );
      res.redirect(`${config.APP_URL}/callback?error=${errorMsg}`);
      return;
    }

    // Identifying the account, persisting it, and issuing the cookie is shared
    // with the local token provider, so a fix to either applies to both.
    const result = await establishSession(
      res,
      {
        accessToken: tokenData.access_token,
        tokenType: tokenData.token_type,
        scope: tokenData.scope,
      },
      { authMethod: 'oauth', userAgent: req.headers['user-agent'] ?? null }
    );

    if (!result.ok) {
      res.redirect(`${config.APP_URL}/callback?error=${encodeURIComponent(result.reason)}`);
      return;
    }

    // Clear OAuth state cookie
    res.cookie('github_oauth_state', '', {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });

    // Redirect to app with success
    res.redirect(`${config.APP_URL}/callback?success=true`);
  } catch (error) {
    logError('OAuth callback error', error);
    res.redirect(`${config.APP_URL}/callback?error=Internal%20server%20error`);
  }
});

export default router;
