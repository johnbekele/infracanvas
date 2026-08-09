import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { deleteGitHubToken, getGitHubToken, hasGitHubToken, saveGitHubToken } from './tokens.js';
import { findOrCreateUser } from './users.js';

const MISSING_USER = '00000000-0000-0000-0000-000000000000';

async function createUser(githubId = 4242) {
  return findOrCreateUser({
    githubId,
    githubUsername: `user-${githubId}`,
    githubAvatar: 'https://example.com/a.png',
  });
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('saveGitHubToken', () => {
  it('round-trips a token through encryption', async () => {
    const user = await createUser();
    await saveGitHubToken({
      userId: user.id,
      accessToken: 'gho_secretvalue',
      tokenType: 'bearer',
      scope: 'repo',
    });

    expect(await getGitHubToken(user.id)).toBe('gho_secretvalue');
  });

  it('never writes the plaintext token to the database', async () => {
    const user = await createUser();
    await saveGitHubToken({
      userId: user.id,
      accessToken: 'gho_secretvalue',
      tokenType: 'bearer',
      scope: 'repo',
    });

    const { rows } = await query<{ access_token_encrypted: string }>(
      'SELECT access_token_encrypted FROM github_tokens WHERE user_id = $1',
      [user.id]
    );
    expect(rows[0].access_token_encrypted).not.toContain('gho_secretvalue');
  });

  it('replaces the previous token instead of accumulating rows', async () => {
    const user = await createUser();
    const base = { userId: user.id, tokenType: 'bearer', scope: 'repo' };

    await saveGitHubToken({ ...base, accessToken: 'gho_first' });
    await saveGitHubToken({ ...base, accessToken: 'gho_second' });

    expect(await getGitHubToken(user.id)).toBe('gho_second');

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM github_tokens');
    expect(rows[0].count).toBe('1');
  });

  it('rejects a token for a user that does not exist', async () => {
    // The foreign key is what stops an orphaned credential from outliving the
    // account it belongs to.
    await expect(
      saveGitHubToken({
        userId: MISSING_USER,
        accessToken: 'gho_orphan',
        tokenType: 'bearer',
        scope: 'repo',
      })
    ).rejects.toThrow();
  });
});

describe('getGitHubToken', () => {
  it('returns null when the user has no token', async () => {
    const user = await createUser();
    expect(await getGitHubToken(user.id)).toBeNull();
  });

  it('returns null rather than throwing when the stored value cannot be decrypted', async () => {
    // Simulates a rotated ENCRYPTION_KEY. The caller should see "reconnect your
    // account", not a 500.
    const user = await createUser();
    await saveGitHubToken({
      userId: user.id,
      accessToken: 'gho_secretvalue',
      tokenType: 'bearer',
      scope: 'repo',
    });
    await query('UPDATE github_tokens SET access_token_encrypted = $1 WHERE user_id = $2', [
      'not-valid-ciphertext',
      user.id,
    ]);

    expect(await getGitHubToken(user.id)).toBeNull();
  });
});

describe('hasGitHubToken', () => {
  it('is true once a token is stored', async () => {
    const user = await createUser();
    await saveGitHubToken({
      userId: user.id,
      accessToken: 'gho_secretvalue',
      tokenType: 'bearer',
      scope: 'repo',
    });

    expect(await hasGitHubToken(user.id)).toBe(true);
  });

  it('is false for a user with no token', async () => {
    const user = await createUser();
    expect(await hasGitHubToken(user.id)).toBe(false);
  });

  it('is false for a user that does not exist', async () => {
    expect(await hasGitHubToken(MISSING_USER)).toBe(false);
  });
});

describe('deleteGitHubToken', () => {
  it('removes the token', async () => {
    const user = await createUser();
    await saveGitHubToken({
      userId: user.id,
      accessToken: 'gho_secretvalue',
      tokenType: 'bearer',
      scope: 'repo',
    });
    await deleteGitHubToken(user.id);

    expect(await hasGitHubToken(user.id)).toBe(false);
  });

  it('is a no-op when there is nothing to delete', async () => {
    await expect(deleteGitHubToken(MISSING_USER)).resolves.toBeUndefined();
  });
});

describe('account deletion', () => {
  it('removes the token with the user it belongs to', async () => {
    const user = await createUser();
    await saveGitHubToken({
      userId: user.id,
      accessToken: 'gho_secretvalue',
      tokenType: 'bearer',
      scope: 'repo',
    });

    await query('DELETE FROM users WHERE id = $1', [user.id]);

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM github_tokens');
    expect(rows[0].count).toBe('0');
  });
});
