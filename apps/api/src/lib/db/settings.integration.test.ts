import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from './settings.js';
import {
  defaultCredential,
  deleteCredential,
  findCredential,
  getDecryptedKey,
  listCredentials,
  saveCredential,
  setDefaultCredential,
} from './llm-credentials.js';

const API_KEY = 'sk-integration-value-wxyz';

async function createUser(githubId = 7001) {
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

describe('getSettings', () => {
  it('returns defaults for a user with no settings row', async () => {
    // No row is written at sign-up, so a user who has never opened the settings
    // page must still get a usable answer rather than a null.
    const user = await createUser();

    expect(await getSettings(user.id)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('updateSettings', () => {
  it('creates the row on first write and returns the new values', async () => {
    const user = await createUser();

    const settings = await updateSettings(user.id, {
      defaultRegion: 'eu-west-1',
      reasoningScale: 'thorough',
    });

    expect(settings.defaultRegion).toBe('eu-west-1');
    expect(settings.reasoningScale).toBe('thorough');
    expect(await getSettings(user.id)).toEqual(settings);
  });

  it('leaves fields the patch does not mention alone', async () => {
    const user = await createUser();
    await updateSettings(user.id, { defaultRegion: 'eu-west-1', monthlyTokenBudget: 500_000 });

    const settings = await updateSettings(user.id, { currency: 'EUR' });

    expect(settings.defaultRegion).toBe('eu-west-1');
    expect(settings.monthlyTokenBudget).toBe(500_000);
    expect(settings.currency).toBe('EUR');
  });

  it('clears the budget when the patch sets it to null', async () => {
    const user = await createUser();
    await updateSettings(user.id, { monthlyTokenBudget: 500_000 });

    const settings = await updateSettings(user.id, { monthlyTokenBudget: null });

    expect(settings.monthlyTokenBudget).toBeNull();
  });

  it('refuses a reasoning scale the rest of the system cannot map', async () => {
    // The check constraint is the last line of defence behind route validation.
    const user = await createUser();

    await expect(
      updateSettings(user.id, { reasoningScale: 'exhaustive' as never })
    ).rejects.toThrow();
  });
});

describe('saveCredential', () => {
  it('never returns a stored api key', async () => {
    const user = await createUser();
    const credential = await saveCredential({
      userId: user.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
    });

    // Checked over the serialised form rather than a named field, because the
    // point is that no field carries it, whatever it might be called.
    expect(JSON.stringify(credential)).not.toContain(API_KEY);
    expect(JSON.stringify(await listCredentials(user.id))).not.toContain(API_KEY);
    expect(JSON.stringify(await findCredential(user.id, credential.id))).not.toContain(API_KEY);
  });

  it('never writes the key in a readable form', async () => {
    const user = await createUser();
    const credential = await saveCredential({
      userId: user.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
    });

    const { rows } = await query<{ api_key_encrypted: string }>(
      'SELECT api_key_encrypted FROM llm_credentials WHERE id = $1',
      [credential.id]
    );

    expect(rows[0].api_key_encrypted).not.toContain(API_KEY);
    expect(await getDecryptedKey(user.id, credential.id)).toBe(API_KEY);
  });

  it('stores only the last four characters as a hint', async () => {
    const user = await createUser();

    const credential = await saveCredential({
      userId: user.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
    });

    expect(credential.keyHint).toBe('wxyz');
  });

  it('stores a credential with no key at all for providers that authenticate another way', async () => {
    const user = await createUser();

    const credential = await saveCredential({
      userId: user.id,
      provider: 'bedrock',
      model: 'anthropic.claude-sonnet-4-5-v1:0',
    });

    expect(credential.keyHint).toBeNull();
    expect(await getDecryptedKey(user.id, credential.id)).toBeNull();
  });

  it('replaces the same provider and model rather than accumulating rows', async () => {
    const user = await createUser();
    const base = { userId: user.id, provider: 'openai' as const, model: 'gpt-4.1' };

    await saveCredential({ ...base, apiKey: 'sk-first-key-aaaa' });
    const second = await saveCredential({ ...base, apiKey: 'sk-second-key-bbbb' });

    expect(await getDecryptedKey(user.id, second.id)).toBe('sk-second-key-bbbb');
    expect(await listCredentials(user.id)).toHaveLength(1);
  });

  it('keeps the stored key when it is re-saved without one', async () => {
    // Editing the base URL of a working credential should not make the user
    // find their key again.
    const user = await createUser();
    const base = { userId: user.id, provider: 'openai' as const, model: 'gpt-4.1' };
    const first = await saveCredential({ ...base, apiKey: API_KEY });

    await saveCredential({ ...base, baseUrl: 'https://proxy.example.com/v1' });

    expect(await getDecryptedKey(user.id, first.id)).toBe(API_KEY);
  });
});

describe('the default credential', () => {
  it('clears the previous default when a new one is set', async () => {
    const user = await createUser();
    const openai = await saveCredential({
      userId: user.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
      makeDefault: true,
    });
    const ollama = await saveCredential({ userId: user.id, provider: 'ollama', model: 'llama3.3' });

    await setDefaultCredential(user.id, ollama.id);

    expect((await defaultCredential(user.id))?.id).toBe(ollama.id);
    expect((await findCredential(user.id, openai.id))?.isDefault).toBe(false);
  });

  it('is the only one, even after several are marked', async () => {
    const user = await createUser();
    const openai = await saveCredential({
      userId: user.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
      makeDefault: true,
    });
    const ollama = await saveCredential({
      userId: user.id,
      provider: 'ollama',
      model: 'llama3.3',
      makeDefault: true,
    });

    const credentials = await listCredentials(user.id);

    expect(credentials.filter((entry) => entry.isDefault)).toHaveLength(1);
    expect((await defaultCredential(user.id))?.id).toBe(ollama.id);
    expect(credentials.find((entry) => entry.id === openai.id)?.isDefault).toBe(false);
  });

  it('is absent rather than arbitrary when nothing is marked', async () => {
    const user = await createUser();
    await saveCredential({ userId: user.id, provider: 'ollama', model: 'llama3.3' });

    expect(await defaultCredential(user.id)).toBeNull();
  });
});

describe('ownership', () => {
  it('does not return a credential belonging to another user', async () => {
    // A 403 would confirm the id exists, which is more than the caller should
    // learn from an id they guessed.
    const owner = await createUser(7001);
    const other = await createUser(7002);
    const credential = await saveCredential({
      userId: owner.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
    });

    expect(await findCredential(other.id, credential.id)).toBeNull();
    expect(await getDecryptedKey(other.id, credential.id)).toBeNull();
    expect(await deleteCredential(other.id, credential.id)).toBe(false);
    expect(await findCredential(owner.id, credential.id)).not.toBeNull();
  });

  it('does not let one user steal the default of another', async () => {
    const owner = await createUser(7001);
    const other = await createUser(7002);
    const credential = await saveCredential({
      userId: owner.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
      makeDefault: true,
    });

    expect(await setDefaultCredential(other.id, credential.id)).toBeNull();
    expect((await defaultCredential(owner.id))?.id).toBe(credential.id);
  });
});

describe('account deletion', () => {
  it('takes the settings and the keys with it', async () => {
    const user = await createUser();
    await updateSettings(user.id, { defaultRegion: 'eu-west-1' });
    await saveCredential({
      userId: user.id,
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: API_KEY,
    });

    await query('DELETE FROM users WHERE id = $1', [user.id]);

    const credentials = await query<{ count: string }>(
      'SELECT count(*) AS count FROM llm_credentials'
    );
    const settings = await query<{ count: string }>('SELECT count(*) AS count FROM user_settings');

    expect(credentials.rows[0].count).toBe('0');
    expect(settings.rows[0].count).toBe('0');
  });
});
