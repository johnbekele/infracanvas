import { Router, type Express } from 'express';

import { requireServiceToken, serviceToken } from '../../middleware/service-token.js';
import previewRoutes from './preview.js';

/**
 * Routes another process on the loopback interface calls, never a browser.
 *
 * The whole router sits behind the shared service token, and it is mounted only
 * when that token is configured: a deployment with nothing to serve here has
 * the path 404 rather than 401, so an unauthenticated caller is not told that a
 * credential exists.
 */

const router: Router = Router();

router.use((_req, res, next) => {
  // Nothing in a browser calls this. The global CORS middleware sets a
  // permissive header for the application's own origin, and stripping it here
  // rather than relying on mount order means the property holds however this
  // router is wired up.
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Vary', 'Origin');
  next();
});

router.use(requireServiceToken);
router.use('/ir', previewRoutes);

export default router;

/**
 * Mounts the internal plane when it is configured, and reports whether it did,
 * so a caller can log the decision rather than guess at it.
 */
export function mountInternalRoutes(app: Express): boolean {
  if (serviceToken() === undefined) return false;
  app.use('/internal', router);
  return true;
}
