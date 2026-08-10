// Auth routes barrel export
import { Router } from 'express';
import githubRoute from './github.js';
import callbackRoute from './callback.js';
import statusRoute from './status.js';
import logoutRoute from './logout.js';
import methodsRoute from './methods.js';
import { apiRateLimit, signInRateLimit } from '../../middleware/rate-limit.js';

const router = Router();

// Everything under /auth is ordinary traffic; the two endpoints that accept a
// credential are additionally held to the much lower sign-in ceiling below.
router.use(apiRateLimit);

// Mount routes
router.use('/methods', methodsRoute);
router.use('/github', signInRateLimit, githubRoute);
router.use('/github/callback', signInRateLimit, callbackRoute);
router.use('/status', statusRoute);
router.use('/logout', logoutRoute);

export default router;
