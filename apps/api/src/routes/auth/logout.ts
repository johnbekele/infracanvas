// Logout endpoint
import { Router, type Request, type Response } from 'express';
import { env } from '../../lib/env.js';
import { SESSION_COOKIE_NAME } from '../../middleware/auth.js';

const router = Router();

/**
 * POST /auth/logout
 * Clears the session cookie to log out the user
 */
router.post('/', (_req: Request, res: Response) => {
  const config = env();

  // Clear session cookie
  res.cookie(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  res.json({ success: true });
});

export default router;
