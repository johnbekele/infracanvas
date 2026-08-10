// Model credentials. The key is encrypted at rest and never leaves the server.
import { query, withTransaction } from './client.js';
import { decrypt, encrypt } from '../encryption.js';
import { logError } from '../log.js';
import type { LlmProvider } from '@infracanvas/core';

/**
 * A credential as the browser is allowed to see it.
 *
 * There is deliberately no field here that could hold the key. A response type
 * that cannot express the secret is a stronger guarantee than remembering to
 * strip it at each call site.
 */
export interface LlmCredential {
  id: string;
  provider: LlmProvider;
  model: string;
  /** Last four characters, so a user can tell which key is stored. */
  keyHint: string | null;
  baseUrl: string | null;
  isDefault: boolean;
  createdAt: Date;
}

interface CredentialRow {
  id: string;
  provider: LlmProvider;
  model: string;
  key_hint: string | null;
  base_url: string | null;
  is_default: boolean;
  created_at: Date;
}

const PUBLIC_COLUMNS = 'id, provider, model, key_hint, base_url, is_default, created_at';

function toCredential(row: CredentialRow): LlmCredential {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    keyHint: row.key_hint,
    baseUrl: row.base_url,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

/** The last four characters of a key, which is enough to recognise it by. */
export function hintFor(apiKey: string): string {
  return apiKey.slice(-4);
}

export interface SaveCredentialInput {
  userId: string;
  provider: LlmProvider;
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  makeDefault?: boolean;
}

export async function listCredentials(userId: string): Promise<LlmCredential[]> {
  const result = await query<CredentialRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM llm_credentials
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at DESC`,
    [userId]
  );

  return result.rows.map(toCredential);
}

/**
 * Store a credential, replacing any existing one for the same provider and model.
 *
 * Re-saving without a key keeps the stored one, so a user editing the base URL
 * of a working credential is not made to paste their key again to do it.
 */
export async function saveCredential(input: SaveCredentialInput): Promise<LlmCredential> {
  return withTransaction(async (client) => {
    if (input.makeDefault) {
      // Cleared inside the transaction that sets the new one, so the unique
      // partial index never sees two defaults and a failure leaves neither
      // half-applied.
      await client.query(`UPDATE llm_credentials SET is_default = false WHERE user_id = $1`, [
        input.userId,
      ]);
    }

    const encrypted = input.apiKey ? encrypt(input.apiKey) : null;
    const hint = input.apiKey ? hintFor(input.apiKey) : null;

    const result = await client.query<CredentialRow>(
      `INSERT INTO llm_credentials (user_id, provider, model, api_key_encrypted, key_hint, base_url, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, provider, model) DO UPDATE
         SET api_key_encrypted = COALESCE(EXCLUDED.api_key_encrypted, llm_credentials.api_key_encrypted),
             key_hint          = COALESCE(EXCLUDED.key_hint, llm_credentials.key_hint),
             base_url          = EXCLUDED.base_url,
             is_default        = EXCLUDED.is_default OR llm_credentials.is_default
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        input.userId,
        input.provider,
        input.model,
        encrypted,
        hint,
        input.baseUrl ?? null,
        input.makeDefault ?? false,
      ]
    );

    return toCredential(result.rows[0]);
  });
}

/**
 * Every read is scoped by user id.
 *
 * A credential belonging to someone else reads as absent rather than forbidden,
 * because a 403 would confirm that the id exists.
 */
export async function findCredential(userId: string, id: string): Promise<LlmCredential | null> {
  const result = await query<CredentialRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM llm_credentials WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );

  return result.rows[0] ? toCredential(result.rows[0]) : null;
}

/**
 * The decrypted key, for server-side use only.
 *
 * A decryption failure means the ciphertext no longer matches ENCRYPTION_KEY,
 * usually after a key rotation. That is unrecoverable for this row, so it reads
 * as absent and the user is asked to re-enter the key rather than shown an
 * opaque error.
 */
export async function getDecryptedKey(userId: string, id: string): Promise<string | null> {
  const result = await query<{ api_key_encrypted: string | null }>(
    `SELECT api_key_encrypted FROM llm_credentials WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );

  const encrypted = result.rows[0]?.api_key_encrypted;
  if (!encrypted) return null;

  try {
    return decrypt(encrypted);
  } catch (error) {
    logError('Failed to decrypt an LLM credential', error);
    return null;
  }
}

export async function deleteCredential(userId: string, id: string): Promise<boolean> {
  const result = await query(`DELETE FROM llm_credentials WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);

  return result.rowCount === 1;
}

export async function setDefaultCredential(
  userId: string,
  id: string
): Promise<LlmCredential | null> {
  return withTransaction(async (client) => {
    await client.query(`UPDATE llm_credentials SET is_default = false WHERE user_id = $1`, [
      userId,
    ]);

    const result = await client.query<CredentialRow>(
      `UPDATE llm_credentials SET is_default = true
       WHERE id = $1 AND user_id = $2
       RETURNING ${PUBLIC_COLUMNS}`,
      [id, userId]
    );

    return result.rows[0] ? toCredential(result.rows[0]) : null;
  });
}

/** The credential the model-assisted features should use, if any. */
export async function defaultCredential(userId: string): Promise<LlmCredential | null> {
  const result = await query<CredentialRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM llm_credentials WHERE user_id = $1 AND is_default LIMIT 1`,
    [userId]
  );

  return result.rows[0] ? toCredential(result.rows[0]) : null;
}
