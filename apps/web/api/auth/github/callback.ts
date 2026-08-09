// GET /api/auth/github/callback - Exchange code for token
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse as parseCookie, serialize } from 'cookie';
import { getEnv } from '../../_lib/env';
import { createSessionToken } from '../../_lib/jwt';
import { findOrCreateUser, saveGitHubToken } from '../../_lib/db';
import { SESSION_COOKIE_NAME } from '../../_lib/auth';

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const env = getEnv();
  const { code, state, error, error_description } = req.query;

  // Handle OAuth errors
  if (error) {
    const errorMsg = encodeURIComponent(
      String(error_description || error || 'Authentication failed')
    );
    return res.redirect(`${env.APP_URL}/callback?error=${errorMsg}`);
  }

  // Validate code
  if (!code || typeof code !== 'string') {
    return res.redirect(`${env.APP_URL}/callback?error=Missing%20authorization%20code`);
  }

  // Verify state
  const cookies = parseCookie(req.headers.cookie || '');
  if (!state || state !== cookies.github_oauth_state) {
    return res.redirect(`${env.APP_URL}/callback?error=Invalid%20state%20parameter`);
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;

    if (tokenData.error || !tokenData.access_token) {
      const errorMsg = encodeURIComponent(
        tokenData.error_description || tokenData.error || 'Failed to get access token'
      );
      return res.redirect(`${env.APP_URL}/callback?error=${errorMsg}`);
    }

    // Fetch user info
    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!userResponse.ok) {
      return res.redirect(`${env.APP_URL}/callback?error=Failed%20to%20get%20user%20info`);
    }

    const githubUser = (await userResponse.json()) as GitHubUser;

    // Find or create user
    const user = await findOrCreateUser({
      githubId: githubUser.id,
      githubUsername: githubUser.login,
      githubAvatar: githubUser.avatar_url,
      email: githubUser.email || undefined,
      name: githubUser.name || undefined,
    });

    // Save token
    await saveGitHubToken({
      userId: user._id,
      accessToken: tokenData.access_token,
      tokenType: tokenData.token_type,
      scope: tokenData.scope,
    });

    // Create session
    const sessionToken = await createSessionToken({
      userId: user._id.toString(),
      githubId: user.githubId,
      githubUsername: user.githubUsername,
    });

    // Set cookies
    const cookieOptions = {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
    };

    res.setHeader('Set-Cookie', [
      serialize('github_oauth_state', '', { ...cookieOptions, maxAge: 0 }),
      serialize(SESSION_COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: 3600 }),
    ]);

    res.redirect(`${env.APP_URL}/callback?success=true`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`${env.APP_URL}/callback?error=Internal%20server%20error`);
  }
}
