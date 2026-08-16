import { Router } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { apiRateLimit } from '../../middleware/rate-limit.js';
import copilotRoutes from './copilot.js';
import proposalRoutes from './proposals.js';

/**
 * Everything about one experiment that the browser reaches.
 *
 * Authentication is the router's rather than each route's: every path below
 * reads or writes one user's architecture, and a route that forgot the
 * middleware would be a route that served somebody else's.
 */

const router: Router = Router();

router.use(apiRateLimit);
router.use(requireAuth);

router.use('/:id/copilot/proposals', proposalRoutes);
router.use('/:id/copilot', copilotRoutes);

export default router;
