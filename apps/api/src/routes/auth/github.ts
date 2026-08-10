// Start of the login flow.
//
// The method is chosen per request rather than per deployment. Under `oauth`
// this redirects to GitHub; under `token` there is nobody to redirect to,
// because the token already exists locally, so the session is established here
// and the browser lands on the same destination the OAuth callback would have
// sent it to. The web app cannot tell the two apart.
import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { env } from '../../lib/env.js';
import { resolveGitHubToken, NO_TOKEN_GUIDANCE } from '../../lib/auth/token-source.js';
import { establishSession } from '../../lib/auth/session.js';
import { chooseMethod } from '../../lib/auth/methods.js';
import { logError } from '../../lib/log.js';

const router = Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

const SCOPES = ['repo', 'read:user', 'user:email'];

function redirectToGitHub(res: Response): void {
  const config = env();

  const state = randomBytes(32).toString('hex');

  const params = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID,
    redirect_uri: `${config.API_URL}/auth/github/callback`,
    scope: SCOPES.join(' '),
    state,
    allow_signup: 'true',
  });

  res.cookie('github_oauth_state', state, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000,
    path: '/',
  });

  res.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
}

async function signInWithLocalToken(req: Request, res: Response): Promise<void> {
  const config = env();

  const resolved = await resolveGitHubToken();

  if (!resolved) {
    res.status(500).json({ error: NO_TOKEN_GUIDANCE });
    return;
  }

  // The scope is unknown for a token obtained this way: neither the environment
  // nor `gh` reports one, and GitHub only reveals it on an API response header.
  // Recording where it came from is more use to a later reader than a guess.
  const result = await establishSession(
    res,
    {
      accessToken: resolved.token,
      tokenType: 'bearer',
      scope: `local:${resolved.origin}`,
    },
    {
      authMethod: 'token',
      tokenOrigin: resolved.origin,
      userAgent: req.headers['user-agent'] ?? null,
    }
  );

  if (!result.ok) {
    res.status(502).json({ error: result.reason });
    return;
  }

  res.redirect(`${config.APP_URL}/callback?success=true`);
}

/**
 * GET /auth/github?method=oauth|token
 *
 * An unavailable method is refused with the reason rather than redirected into
 * a flow that cannot complete.
 */
router.get('/', async (req: Request, res: Response) => {
  const choice = chooseMethod(req, req.query.method);

  if (!choice.ok) {
    res.status(choice.status).json({ error: choice.error });
    return;
  }

  if (choice.method === 'oauth') {
    redirectToGitHub(res);
    return;
  }

  try {
    await signInWithLocalToken(req, res);
  } catch (error) {
    // Deliberately not forwarding the message: it can carry the token when
    // the failure came from a fetch that embedded the header.
    logError('Local token sign-in failed', error);
    res.status(500).json({ error: 'Sign-in failed. See the API logs for details.' });
  }
});

export default router;
