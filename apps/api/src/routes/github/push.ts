// GitHub push endpoint - atomic multi-file push
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getGitHubToken } from '../../lib/db/tokens.js';

const router = Router();

const GITHUB_API = 'https://api.github.com';

interface PushFile {
  path: string;
  content: string;
}

interface PushRequest {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  files: PushFile[];
}

interface GitHubRef {
  object: { sha: string };
}

interface GitHubCommit {
  sha: string;
  tree: { sha: string };
}

interface GitHubBlob {
  sha: string;
}

interface GitHubTree {
  sha: string;
}

interface GitHubNewCommit {
  sha: string;
  html_url: string;
}

/**
 * POST /github/push
 * Pushes multiple files to a repository in a single atomic commit
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const token = await getGitHubToken(req.session!.userId);

    if (!token) {
      res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
      return;
    }

    const { owner, repo, branch, message, files } = req.body as PushRequest;

    // Validate request
    if (!owner || !repo || !branch || !message || !files || !Array.isArray(files)) {
      res.status(400).json({
        error: 'Missing required fields: owner, repo, branch, message, files',
      });
      return;
    }

    if (files.length === 0) {
      res.status(400).json({ error: 'At least one file is required' });
      return;
    }

    // 1. Get the current commit SHA
    const refResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
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

    const refData = (await refResponse.json()) as GitHubRef;
    const currentCommitSha = refData.object.sha;

    // 2. Get the tree SHA
    const commitResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${currentCommitSha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!commitResponse.ok) {
      const error = await commitResponse.json().catch(() => ({}));
      res.status(commitResponse.status).json(error);
      return;
    }

    const commitData = (await commitResponse.json()) as GitHubCommit;
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blobs for each file
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const blobResponse = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: file.content,
            encoding: 'utf-8',
          }),
        });

        if (!blobResponse.ok) {
          throw new Error(`Failed to create blob for ${file.path}`);
        }

        const blobData = (await blobResponse.json()) as GitHubBlob;

        return {
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blobData.sha,
        };
      })
    );

    // 4. Create a new tree
    const treeResponse = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeItems,
      }),
    });

    if (!treeResponse.ok) {
      const error = await treeResponse.json().catch(() => ({}));
      res.status(treeResponse.status).json(error);
      return;
    }

    const treeData = (await treeResponse.json()) as GitHubTree;

    // 5. Create a new commit
    const newCommitResponse = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/commits`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        tree: treeData.sha,
        parents: [currentCommitSha],
      }),
    });

    if (!newCommitResponse.ok) {
      const error = await newCommitResponse.json().catch(() => ({}));
      res.status(newCommitResponse.status).json(error);
      return;
    }

    const newCommitData = (await newCommitResponse.json()) as GitHubNewCommit;

    // 6. Update the branch reference
    const updateRefResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sha: newCommitData.sha,
        }),
      }
    );

    if (!updateRefResponse.ok) {
      const error = await updateRefResponse.json().catch(() => ({}));
      res.status(updateRefResponse.status).json(error);
      return;
    }

    res.json({
      success: true,
      message: `Successfully pushed ${files.length} files`,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitData.sha}`,
      commitSha: newCommitData.sha,
    });
  } catch (error) {
    console.error('Error pushing files:', error);
    res.status(500).json({
      error: 'Failed to push files',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
