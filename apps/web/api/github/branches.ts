// GET/POST /api/github/branches?owner=X&repo=Y - List or create branches
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession, setCorsHeaders } from '../_lib/auth';
import { getGitHubToken } from '../_lib/db';

const GITHUB_API = 'https://api.github.com';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(204).end();

  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });

  const token = await getGitHubToken(session.userId);
  if (!token) return res.status(401).json({ error: 'GitHub token not found' });

  const { owner, repo } = req.query;
  if (!owner || !repo) {
    return res.status(400).json({ error: 'owner and repo query params required' });
  }

  try {
    if (req.method === 'GET') {
      const response = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/branches`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
          },
        }
      );
      const data = await response.json();
      return res.status(response.status).json(data);
    }

    if (req.method === 'POST') {
      const { branchName, fromBranch } = req.body;

      if (!branchName || !fromBranch) {
        return res.status(400).json({ error: 'branchName and fromBranch are required' });
      }

      // Get SHA of source branch
      const refResponse = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
          },
        }
      );

      if (!refResponse.ok) {
        const error = await refResponse.json();
        return res.status(refResponse.status).json(error);
      }

      const refData = (await refResponse.json()) as { object: { sha: string } };

      // Create branch
      const createResponse = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/git/refs`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ref: `refs/heads/${branchName}`,
            sha: refData.object.sha,
          }),
        }
      );

      const data = await createResponse.json();
      return res.status(createResponse.status).json(data);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error with branches:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
}
