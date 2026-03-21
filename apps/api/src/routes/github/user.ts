// GitHub user endpoint
import { Router, Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getGitHubToken } from '../../lib/db/tokens.js';

const router = Router();

const GITHUB_API = 'https://api.github.com';

/**
 * GET /github/user
 * Returns the authenticated user's GitHub profile
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req.session!.userId);

    if (!token) {
      res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
      return;
    }

    const response = await fetch(`${GITHUB_API}/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      res.status(response.status).json(error);
      return;
    }

    const user = await response.json();
    res.json(user);
  } catch (error) {
    console.error('Error fetching GitHub user:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub user' });
  }
});

export default router;
