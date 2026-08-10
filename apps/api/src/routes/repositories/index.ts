// Repositories a user has connected for analysis.
//
// Distinct from `/github/repos`, which is a thin proxy listing what exists on
// GitHub. This is the application's own record of the repositories a user has
// chosen to work with, and what everything downstream -- analysis, generated
// architecture, deployment -- hangs off.
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { apiRateLimit } from '../../middleware/rate-limit.js';
import { getGitHubToken } from '../../lib/db/tokens.js';
import {
  connectRepository,
  listRepositories,
  findRepository,
  disconnectRepository,
} from '../../lib/db/repositories.js';
import { assertRepoCoordinates, InvalidGitHubParamError } from '../../lib/github-params.js';
import analysesRouter from './analyses.js';

const router = Router();

router.use(apiRateLimit);
router.use(requireAuth);

router.use('/:repositoryId/analyses', analysesRouter);

const GITHUB_API = 'https://api.github.com';

/** The fields this application needs from GitHub's repository payload. */
interface GitHubRepo {
  id: number;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
}

/**
 * GET /repositories
 * The caller's connected repositories, newest first.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const repositories = await listRepositories(req.session!.userId);
    res.json({ repositories });
  } catch (error) {
    console.error('Failed to list repositories:', error);
    res.status(500).json({ error: 'Failed to list repositories' });
  }
});

/**
 * POST /repositories
 * Connect a repository by owner and name.
 *
 * The details are read from GitHub rather than taken from the request body.
 * A client that sent its own `defaultBranch` or `isPrivate` could record a
 * repository the user cannot actually see, or mark a private one public, and
 * every later decision would be built on that claim.
 */
router.post('/', async (req: Request, res: Response) => {
  let owner: string;
  let repo: string;

  try {
    ({ owner, repo } = assertRepoCoordinates(req.body ?? {}));
  } catch (error) {
    if (error instanceof InvalidGitHubParamError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  try {
    const token = await getGitHubToken(req.session!.userId);
    if (!token) {
      res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
      return;
    }

    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (response.status === 404) {
      // GitHub returns 404 rather than 403 for a private repository the token
      // cannot see, so this covers both "does not exist" and "not yours".
      res.status(404).json({ error: `${owner}/${repo} was not found, or you cannot access it.` });
      return;
    }

    if (!response.ok) {
      res.status(502).json({ error: `GitHub returned ${response.status} for ${owner}/${repo}.` });
      return;
    }

    const details = (await response.json()) as GitHubRepo;

    const repository = await connectRepository({
      userId: req.session!.userId,
      githubId: details.id,
      // Taken from the payload rather than the request, so the casing matches
      // GitHub's own and two spellings of the same repository cannot both be
      // connected.
      githubOwner: details.owner.login,
      githubName: details.name,
      defaultBranch: details.default_branch,
      isPrivate: details.private,
    });

    res.status(201).json({ repository });
  } catch (error) {
    console.error('Failed to connect repository:', error);
    res.status(500).json({ error: 'Failed to connect repository' });
  }
});

/**
 * GET /repositories/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const repository = await findRepository(req.session!.userId, req.params.id);

    if (!repository) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    res.json({ repository });
  } catch (error) {
    console.error('Failed to fetch repository:', error);
    res.status(500).json({ error: 'Failed to fetch repository' });
  }
});

/**
 * DELETE /repositories/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const removed = await disconnectRepository(req.session!.userId, req.params.id);

    if (!removed) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    res.status(204).end();
  } catch (error) {
    console.error('Failed to disconnect repository:', error);
    res.status(500).json({ error: 'Failed to disconnect repository' });
  }
});

export default router;
