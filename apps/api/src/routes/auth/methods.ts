// What sign-in methods this caller can use.
//
// Advertised rather than assumed, so the login screen offers exactly what will
// work. A button that leads to a 403 is worse than no button.
import { Router, type Request, type Response } from 'express';
import { availableMethods } from '../../lib/auth/methods.js';

const router = Router();

/**
 * GET /auth/methods
 */
router.get('/', (req: Request, res: Response) => {
  // Availability depends on where the request came from, so this must not be
  // cached by a proxy shared between a local and a remote caller.
  res.setHeader('Cache-Control', 'no-store');
  res.json(availableMethods(req));
});

export default router;
