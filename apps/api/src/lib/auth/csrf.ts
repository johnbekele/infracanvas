// CSRF tokens bound to a session id.
//
// Double-submit alone would accept a token minted for another session if both
// cookies were somehow present. HMAC over the session id with JWT_SECRET means
// a token only authorises the session it was minted for, without a per-session
// store.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/** HMAC over the session id with JWT_SECRET, base64url. */
export function mintCsrfToken(sessionId: string): string {
  return createHmac('sha256', env().JWT_SECRET).update(sessionId).digest('base64url');
}

/**
 * Constant-time comparison. Returns false rather than throwing on any
 * malformed input, because a thrown error here becomes a 500 on a request that
 * should be a 403.
 */
export function csrfTokenMatches(sessionId: string, presented: string): boolean {
  try {
    if (!sessionId || typeof presented !== 'string' || presented.length === 0) {
      return false;
    }
    const expected = mintCsrfToken(sessionId);
    const expectedBuf = Buffer.from(expected);
    const presentedBuf = Buffer.from(presented);
    // timingSafeEqual throws on length mismatch; treat that as a miss.
    if (expectedBuf.length !== presentedBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, presentedBuf);
  } catch {
    return false;
  }
}
