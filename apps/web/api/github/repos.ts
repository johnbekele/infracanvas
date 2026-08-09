// GET/POST /api/github/repos - List or create repos
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

  try {
    if (req.method === 'GET') {
      const response = await fetch(
        `${GITHUB_API}/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );
      const data = await response.json();
      return res.status(response.status).json(data);
    }

    if (req.method === 'POST') {
      const { name, description, isPrivate } = req.body;

      if (!name) return res.status(400).json({ error: 'Repository name is required' });

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
      return res.status(response.status).json(data);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error with repos:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
}
