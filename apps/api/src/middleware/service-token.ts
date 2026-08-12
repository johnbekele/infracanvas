import { createHash, timingSafeEqual } from 'node:crypto';
import { type NextFunction, type Request, type Response } from 'express';

import { envSafe } from '../lib/env.js';

/**
 * The shared credential another process presents to reach the internal plane.
 *
 * It is compared over sha-256 digests rather than over the strings themselves,
 * so the comparison is constant time and independent of length:
 * `timingSafeEqual` throws on buffers of different sizes, and returning early
 * on a length mismatch would leak the length of the real token. Digesting both
 * sides makes every comparison a fixed 32 bytes.
 */

export const SERVICE_TOKEN_HEADER = 'x-infracanvas-service-token';

/** Short enough to brute force is not a credential. `openssl rand -hex 32` produces 64. */
export const MIN_SERVICE_TOKEN_LENGTH = 32;

/**
 * The configured token, or nothing. A token below the minimum length counts as
 * absent rather than as weak: the internal plane then never mounts, which fails
 * closed, and `env()` refuses to start the process for the same reason.
 */
export function serviceToken(): string | undefined {
  const configured = envSafe().BRAIN_SERVICE_TOKEN;
  if (configured === undefined || configured.length < MIN_SERVICE_TOKEN_LENGTH) return undefined;
  return configured;
}

function equal(presented: string, configured: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented, 'utf8').digest(),
    createHash('sha256').update(configured, 'utf8').digest()
  );
}

/**
 * Refuses anything without the configured token.
 *
 * When `BRAIN_SERVICE_TOKEN` is unset the internal router is not mounted at
 * all and the path 404s rather than 401ing, so this middleware never sees a
 * request in that deployment. A 401 would tell an unauthenticated caller that
 * a credential would get them in, and a deployment with no second process has
 * no such credential to leak.
 */
export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  const configured = serviceToken();
  const presented = req.header(SERVICE_TOKEN_HEADER) ?? '';

  if (configured === undefined || presented === '' || !equal(presented, configured)) {
    // The outcome is logged and nothing off the request is. A rejected token is
    // still a credential, and one in a log line is one in a log aggregator; a
    // path is not a credential but it is written by the caller, and a caller
    // who can put a newline in a log line can write a log line.
    console.warn('Refused an internal request: service token absent or wrong');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
