// Start of the login flow.
//
// Under the `oauth` provider this redirects to GitHub. Under `token` there is
// nobody to redirect to: the token already exists locally, so the session is
// established here and the browser lands on the same destination the OAuth
// callback would have sent it to. The web app cannot tell the two apart.
import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { env } from '../../lib/env.js';
import { resolveGitHubToken, NO_TOKEN_GUIDANCE } from '../../lib/auth/token-source.js';
import { establishSession } from '../../lib/auth/session.js';
import { isLoopbackAddress } from '../../lib/auth/loopback.js';

const router = Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

const SCOPES = ['repo', 'read:user', 'user:email'];

/**
 * The token provider signs the caller in as the operator's own GitHub account
 * with `repo` scope. On a laptop that is the point. Reachable from a network it
 * is an open door to every repository the operator can see, so remote callers
 * are refused unless the operator has said otherwise.
 *
 * Deliberately reads the socket address rather than `req.ip`. The two are the
 * same today, but `req.ip` follows `X-Forwarded-For` as soon as anyone enables
 * `trust proxy` -- an ordinary thing to do when deploying behind a load
 * balancer -- and at that moment this check would start believing a header the
 * caller controls. The TCP peer address cannot be forged that way.
 */
function isLoopback(req: Request): boolean {
  return isLoopbackAddress(req.socket.remoteAddress ?? undefined);
}

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

  if (!isLoopback(req) && !config.AUTH_TOKEN_ALLOW_REMOTE) {
    res.status(403).json({
      error:
        'The token auth provider only accepts requests from this machine. It signs the caller ' +
        'in as the operator, so exposing it to a network would share that account. Set ' +
        'AUTH_TOKEN_ALLOW_REMOTE=true only if every caller is trusted with that access.',
    });
    return;
  }

  const resolved = await resolveGitHubToken();

  if (!resolved) {
    res.status(500).json({ error: NO_TOKEN_GUIDANCE });
    return;
  }

  // The scope is unknown for a token obtained this way: neither the environment
  // nor `gh` reports one, and GitHub only reveals it on an API response header.
  // Recording where it came from is more use to a later reader than a guess.
  const result = await establishSession(res, {
    accessToken: resolved.token,
    tokenType: 'bearer',
    scope: `local:${resolved.origin}`,
  });

  if (!result.ok) {
    res.status(502).json({ error: result.reason });
    return;
  }

  res.redirect(`${config.APP_URL}/callback?success=true`);
}

/**
 * GET /auth/github
 */
router.get('/', async (req: Request, res: Response) => {
  const config = env();

  if (config.AUTH_PROVIDER === 'token') {
    try {
      await signInWithLocalToken(req, res);
    } catch (error) {
      // Deliberately not forwarding the message: it can carry the token when
      // the failure came from a fetch that embedded the header.
      console.error('Local token sign-in failed:', error);
      res.status(500).json({ error: 'Sign-in failed. See the API logs for details.' });
    }
    return;
  }

  redirectToGitHub(res);
});

export default router;
