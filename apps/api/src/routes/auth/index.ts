// Auth routes barrel export
import { Router } from 'express';
import githubRoute from './github.js';
import callbackRoute from './callback.js';
import statusRoute from './status.js';
import logoutRoute from './logout.js';
import methodsRoute from './methods.js';
import { authRateLimit } from '../../middleware/rate-limit.js';

const router = Router();

// Apply rate limiting to auth endpoints
router.use(authRateLimit);

// Mount routes
router.use('/methods', methodsRoute);
router.use('/github', githubRoute);
router.use('/github/callback', callbackRoute);
router.use('/status', statusRoute);
router.use('/logout', logoutRoute);

export default router;
