// Logout endpoint
import { Router, type Request, type Response } from 'express';
import { optionalAuth } from '../../middleware/auth.js';
import { revokeSession } from '../../lib/db/sessions.js';
import { clearSessionCookie } from '../../lib/auth/cookie.js';
import { logError } from '../../lib/log.js';

const router = Router();

/**
 * POST /auth/logout
 *
 * Clearing the cookie only stops this browser from sending it. Revoking the row
 * is what makes the token itself stop working, which matters because a JWT is
 * valid until it expires no matter who is holding it.
 */
router.post('/', optionalAuth, async (req: Request, res: Response) => {
  if (req.session?.sessionId) {
    try {
      await revokeSession(req.session.sessionId);
    } catch (error) {
      // The cookie is still cleared, so the user is logged out of this browser
      // either way; failing the request would only hide that from them.
      logError('Failed to revoke session on logout', error);
    }
  }

  clearSessionCookie(res);
  res.json({ success: true });
});

export default router;
