// POST /api/github/push - Atomic multi-file push
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession, setCorsHeaders } from '../_lib/auth';
import { getGitHubToken } from '../_lib/db';

const GITHUB_API = 'https://api.github.com';

interface GitHubRef { object: { sha: string } }
interface GitHubCommit { sha: string; tree: { sha: string } }
interface GitHubBlob { sha: string }
interface GitHubTree { sha: string }
interface GitHubNewCommit { sha: string }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });

  const token = await getGitHubToken(session.userId);
  if (!token) return res.status(401).json({ error: 'GitHub token not found' });

  const { owner, repo, branch, message, files } = req.body;

  if (!owner || !repo || !branch || !message || !files || !Array.isArray(files)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (files.length === 0) {
    return res.status(400).json({ error: 'At least one file required' });
  }

  try {
    // 1. Get current commit SHA
    const refResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
    );

    if (!refResponse.ok) {
      return res.status(refResponse.status).json(await refResponse.json());
    }

    const refData = (await refResponse.json()) as GitHubRef;
    const currentCommitSha = refData.object.sha;

    // 2. Get tree SHA
    const commitResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/commits/${currentCommitSha}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' } }
    );

    if (!commitResponse.ok) {
      return res.status(commitResponse.status).json(await commitResponse.json());
    }

    const commitData = (await commitResponse.json()) as GitHubCommit;

    // 3. Create blobs
    const treeItems = await Promise.all(
      files.map(async (file: { path: string; content: string }) => {
        const blobResponse = await fetch(
          `${GITHUB_API}/repos/${owner}/${repo}/git/blobs`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
          }
        );

        if (!blobResponse.ok) throw new Error(`Failed to create blob for ${file.path}`);
        const blobData = (await blobResponse.json()) as GitHubBlob;

        return { path: file.path, mode: '100644', type: 'blob', sha: blobData.sha };
      })
    );

    // 4. Create tree
    const treeResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ base_tree: commitData.tree.sha, tree: treeItems }),
      }
    );

    if (!treeResponse.ok) {
      return res.status(treeResponse.status).json(await treeResponse.json());
    }

    const treeData = (await treeResponse.json()) as GitHubTree;

    // 5. Create commit
    const newCommitResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, tree: treeData.sha, parents: [currentCommitSha] }),
      }
    );

    if (!newCommitResponse.ok) {
      return res.status(newCommitResponse.status).json(await newCommitResponse.json());
    }

    const newCommitData = (await newCommitResponse.json()) as GitHubNewCommit;

    // 6. Update branch ref
    const updateRefResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha: newCommitData.sha }),
      }
    );

    if (!updateRefResponse.ok) {
      return res.status(updateRefResponse.status).json(await updateRefResponse.json());
    }

    res.json({
      success: true,
      message: `Successfully pushed ${files.length} files`,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitData.sha}`,
      commitSha: newCommitData.sha,
    });
  } catch (err) {
    console.error('Error pushing files:', err);
    res.status(500).json({
      error: 'Failed to push files',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
