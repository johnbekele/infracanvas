// GitHub branches endpoint
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getGitHubToken } from '../../lib/db/tokens.js';
import {
  InvalidGitHubParamError,
  assertBranch,
  assertRepoCoordinates,
  encodeBranch,
} from '../../lib/github-params.js';

const router = Router();

const GITHUB_API = 'https://api.github.com';

/**
 * GET /github/branches/:owner/:repo
 * Returns branches for a repository
 */
router.get('/:owner/:repo', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req.session!.userId);

    if (!token) {
      res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
      return;
    }

    const { owner, repo } = assertRepoCoordinates(req.params);

    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/branches`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      res.status(response.status).json(error);
      return;
    }

    const branches = await response.json();
    res.json(branches);
  } catch (error) {
    if (error instanceof InvalidGitHubParamError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error fetching branches:', error);
    res.status(500).json({ error: 'Failed to fetch branches' });
  }
});

/**
 * POST /github/branches/:owner/:repo
 * Creates a new branch
 */
router.post('/:owner/:repo', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req.session!.userId);

    if (!token) {
      res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
      return;
    }

    const { owner, repo } = assertRepoCoordinates(req.params);

    if (!req.body?.branchName || !req.body?.fromBranch) {
      res.status(400).json({ error: 'branchName and fromBranch are required' });
      return;
    }

    const branchName = assertBranch(req.body.branchName);
    const fromBranch = assertBranch(req.body.fromBranch);

    // Get the SHA of the source branch
    const refResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encodeBranch(fromBranch)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!refResponse.ok) {
      const error = await refResponse.json().catch(() => ({}));
      res.status(refResponse.status).json(error);
      return;
    }

    const refData = (await refResponse.json()) as { object: { sha: string } };

    // Create new branch
    const createResponse = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: refData.object.sha,
      }),
    });

    const createData = await createResponse.json();

    if (!createResponse.ok) {
      res.status(createResponse.status).json(createData);
      return;
    }

    res.json(createData);
  } catch (error) {
    if (error instanceof InvalidGitHubParamError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error creating branch:', error);
    res.status(500).json({ error: 'Failed to create branch' });
  }
});

export default router;
