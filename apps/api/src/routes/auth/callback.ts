// GitHub OAuth callback - exchange code for token
import { Router, type Request, type Response } from 'express';
import { parse as parseCookie } from 'cookie';
import { env } from '../../lib/env.js';
import { createSessionToken } from '../../lib/jwt.js';
import { findOrCreateUser } from '../../lib/db/users.js';
import { saveGitHubToken } from '../../lib/db/tokens.js';
import { SESSION_COOKIE_NAME } from '../../middleware/auth.js';

const router = Router();

// GitHub OAuth URLs
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name: string | null;
  email: string | null;
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

    // Fetch user info from GitHub
    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!userResponse.ok) {
      res.redirect(`${config.APP_URL}/callback?error=Failed%20to%20get%20user%20info`);
      return;
    }

    const githubUser = (await userResponse.json()) as GitHubUser;

    // Find or create user in database
    const user = await findOrCreateUser({
      githubId: githubUser.id,
      githubUsername: githubUser.login,
      githubAvatar: githubUser.avatar_url,
      email: githubUser.email || undefined,
      name: githubUser.name || undefined,
    });

    // Save encrypted GitHub token
    await saveGitHubToken({
      userId: user._id,
      accessToken: tokenData.access_token,
      tokenType: tokenData.token_type,
      scope: tokenData.scope,
    });

    // Create session token
    const sessionToken = await createSessionToken({
      userId: user._id.toString(),
      githubId: user.githubId,
      githubUsername: user.githubUsername,
    });

    // Clear OAuth state cookie
    res.cookie('github_oauth_state', '', {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });

    // Set session cookie
    res.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000, // 1 hour (matches JWT expiry)
      path: '/',
    });

    // Redirect to app with success
    res.redirect(`${config.APP_URL}/callback?success=true`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`${config.APP_URL}/callback?error=Internal%20server%20error`);
  }
});

export default router;
