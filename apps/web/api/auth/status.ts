// GET /api/auth/status - Check authentication status
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession, setCorsHeaders } from '../_lib/auth';
import { findUserById, hasGitHubToken } from '../_lib/db';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req);

  if (!session) {
    return res.json({ authenticated: false });
  }

  try {
    const user = await findUserById(session.userId);

    if (!user) {
      return res.json({ authenticated: false });
    }

    const hasToken = await hasGitHubToken(session.userId);

    res.json({
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
    });
  } catch (err) {
    console.error('Error fetching auth status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
