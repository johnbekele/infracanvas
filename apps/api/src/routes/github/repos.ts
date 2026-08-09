// GitHub repositories endpoint
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getGitHubToken } from '../../lib/db/tokens.js';

const router = Router();

const GITHUB_API = 'https://api.github.com';

/**
 * GET /github/repos
 * Returns the authenticated user's repositories
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req.session!.userId);

    if (!token) {
      res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
      return;
    }

    // Get repos where user can push (owned + collaborator)
    const response = await fetch(
      `${GITHUB_API}/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      res.status(response.status).json(error);
      return;
    }

    const repos = await response.json();
    res.json(repos);
  } catch (error) {
    console.error('Error fetching repos:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

/**
 * POST /github/repos
 * Creates a new repository
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req.session!.userId);

    if (!token) {
      res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
      return;
    }

    const { name, description, isPrivate } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Repository name is required' });
      return;
    }

    const response = await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description: description || '',
        private: isPrivate !== false,
        auto_init: true,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json(data);
      return;
    }

    res.json(data);
  } catch (error) {
    console.error('Error creating repo:', error);
    res.status(500).json({ error: 'Failed to create repository' });
  }
});

export default router;
