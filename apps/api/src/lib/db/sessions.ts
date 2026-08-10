// Sign-in records, which is what makes a session revocable.
import { query } from './client.js';

export type AuthMethodId = 'oauth' | 'token';

export interface Session {
  id: string;
  userId: string;
  issuedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  authMethod: AuthMethodId;
  tokenOrigin: string | null;
  userAgent: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  issued_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  auth_method: AuthMethodId;
  token_origin: string | null;
  user_agent: string | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    issuedAt: row.issued_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    authMethod: row.auth_method,
    tokenOrigin: row.token_origin,
    userAgent: row.user_agent,
  };
}

export interface CreateSessionInput {
  userId: string;
  expiresAt: Date;
  authMethod: AuthMethodId;
  tokenOrigin?: string | null;
  userAgent?: string | null;
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const result = await query<SessionRow>(
    `INSERT INTO sessions (user_id, expires_at, auth_method, token_origin, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      input.userId,
      input.expiresAt,
      input.authMethod,
      input.tokenOrigin ?? null,
      // Truncated because a user agent is attacker-controlled and unbounded,
      // and nothing reads past the part that identifies the browser.
      input.userAgent?.slice(0, 512) ?? null,
    ]
  );

  return toSession(result.rows[0]);
}

/**
 * A session that is still usable, or null.
 *
 * Expiry is checked here as well as in the JWT because the two can disagree:
 * the row is the authority on when the sign-in ends, and a token minted before
 * a shortened lifetime would otherwise outlive it.
 */
export async function findLiveSession(id: string): Promise<Session | null> {
  const result = await query<SessionRow>(
    `SELECT * FROM sessions
     WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [id]
  );

  return result.rows[0] ? toSession(result.rows[0]) : null;
}

/** Extend a session and record that it was used. Returns false if it is gone. */
export async function touchSession(id: string, expiresAt: Date): Promise<boolean> {
  const result = await query(
    `UPDATE sessions
     SET last_seen_at = now(), expires_at = $2
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [id, expiresAt]
  );

  return result.rowCount === 1;
}

/**
 * End a session.
 *
 * Idempotent, and deliberately not a delete: a revoked row is the record that
 * the sign-in existed and when it ended, which is the part an audit needs.
 */
export async function revokeSession(id: string): Promise<void> {
  await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
}

export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  const result = await query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );

  return result.rowCount ?? 0;
}
