// Auth status endpoint
import { Router, type Request, type Response } from 'express';
import { optionalAuth } from '../../middleware/auth.js';
import { findUserById } from '../../lib/db/users.js';
import { hasGitHubToken } from '../../lib/db/tokens.js';

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
    const hasToken = await hasGitHubToken(user._id);

    const response: AuthStatusResponse = {
      authenticated: true,
      user: {
        id: user._id.toString(),
        githubId: user.githubId,
        githubUsername: user.githubUsername,
        githubAvatar: user.githubAvatar,
        name: user.name,
        email: user.email,
      },
      hasGitHubToken: hasToken,
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching auth status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
