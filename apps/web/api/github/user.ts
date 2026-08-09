// GET /api/github/user - Get authenticated user
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession, setCorsHeaders } from '../_lib/auth';
import { getGitHubToken } from '../_lib/db';

const GITHUB_API = 'https://api.github.com';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'Authentication required' });

  const token = await getGitHubToken(session.userId);
  if (!token) return res.status(401).json({ error: 'GitHub token not found' });

  try {
    const response = await fetch(`${GITHUB_API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Error fetching GitHub user:', err);
    res.status(500).json({ error: 'Failed to fetch GitHub user' });
  }
}
