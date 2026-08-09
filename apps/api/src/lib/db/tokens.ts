// GitHub access tokens. Encrypted at rest; the database never sees plaintext.
import { query } from './client.js';
import { decrypt, encrypt } from '../encryption.js';

export interface SaveTokenInput {
  userId: string;
  accessToken: string;
  tokenType: string;
  scope: string;
}

export async function saveGitHubToken(input: SaveTokenInput): Promise<void> {
  await query(
    `INSERT INTO github_tokens (user_id, access_token_encrypted, token_type, scope)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET access_token_encrypted = EXCLUDED.access_token_encrypted,
           token_type             = EXCLUDED.token_type,
           scope                  = EXCLUDED.scope`,
    [input.userId, encrypt(input.accessToken), input.tokenType, input.scope]
  );
}

/**
 * Returns the decrypted token, or null when there is none.
 *
 * A decryption failure means the stored ciphertext no longer matches the current
 * ENCRYPTION_KEY, usually because the key was rotated. That is unrecoverable for
 * this row, so it is reported as a missing token and the user is asked to
 * reconnect rather than being shown an opaque server error.
 */
export async function getGitHubToken(userId: string): Promise<string | null> {
  const result = await query<{ access_token_encrypted: string }>(
    'SELECT access_token_encrypted FROM github_tokens WHERE user_id = $1',
    [userId]
  );

  const row = result.rows[0];
  if (!row) return null;

  try {
    return decrypt(row.access_token_encrypted);
  } catch (error) {
    console.error('Failed to decrypt GitHub token:', error);
    return null;
  }
}

export async function deleteGitHubToken(userId: string): Promise<void> {
  await query('DELETE FROM github_tokens WHERE user_id = $1', [userId]);
}

export async function hasGitHubToken(userId: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM github_tokens WHERE user_id = $1) AS exists',
    [userId]
  );
  return result.rows[0]?.exists ?? false;
}
