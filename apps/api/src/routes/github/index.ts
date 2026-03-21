// GitHub API proxy routes
import { Router } from 'express';
import userRoute from './user.js';
import reposRoute from './repos.js';
import branchesRoute from './branches.js';
import pushRoute from './push.js';
import { apiRateLimit } from '../../middleware/rate-limit.js';

const router = Router();

// Apply rate limiting
router.use(apiRateLimit);

// Mount routes
router.use('/user', userRoute);
router.use('/repos', reposRoute);
router.use('/branches', branchesRoute);
router.use('/push', pushRoute);

export default router;
