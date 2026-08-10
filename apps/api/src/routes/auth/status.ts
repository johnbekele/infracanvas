// Auth status endpoint
import { Router, type Request, type Response } from 'express';
import { optionalAuth } from '../../middleware/auth.js';
import { findUserById } from '../../lib/db/users.js';
import { hasGitHubToken } from '../../lib/db/tokens.js';
import { findLiveSession, type AuthMethodId } from '../../lib/db/sessions.js';
import { logError } from '../../lib/log.js';

const router = Router();

export interface AuthStatusResponse {
  authenticated: boolean;
  user?: {
    id: string;
    githubId: number;
    githubUsername: string;
    githubAvatar: string;
    name?: string;
    email?: string;
  };
  hasGitHubToken?: boolean;
  /** Which sign-in path issued this session. */
  authMethod?: AuthMethodId;
  /**
   * Where a local token came from: `env` or `gh-cli`.
   *
   * Surfaced because the local method is silent about who it signed you in as.
   * When the gh CLI holds a different account than the operator expects, the
   * only symptom was repositories missing from the list, with nothing tying
   * that back to the token that was picked up.
   */
  tokenOrigin?: string;
}

/**
 * GET /auth/status
 * Returns current authentication status and user info
 */
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  if (!req.session) {
    const response: AuthStatusResponse = { authenticated: false };
    res.json(response);
    return;
  }

  try {
    // Fetch full user info from database
    const user = await findUserById(req.session.userId);

    if (!user) {
      const response: AuthStatusResponse = { authenticated: false };
      res.json(response);
      return;
    }

    // Check if user has a stored GitHub token
    const hasToken = await hasGitHubToken(user.id);
    const session = req.session.sessionId ? await findLiveSession(req.session.sessionId) : null;

    const response: AuthStatusResponse = {
      authenticated: true,
      user: {
        id: user.id,
        githubId: user.githubId,
        githubUsername: user.githubUsername,
        githubAvatar: user.githubAvatar,
        // The database records an absent optional field as null; the response
        // contract omits it. Converting here keeps the JSON the client sees
        // identical to what it saw before the store changed.
        name: user.name ?? undefined,
        email: user.email ?? undefined,
      },
      hasGitHubToken: hasToken,
      authMethod: session?.authMethod,
      tokenOrigin: session?.tokenOrigin ?? undefined,
    };

    res.json(response);
  } catch (error) {
    logError('Error fetching auth status', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
