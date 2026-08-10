import { describe, expect, it, beforeAll } from 'vitest';
import { readPatch, InvalidSettingError } from './index.js';
import { readCredential, InvalidCredentialError } from './llm.js';
import { hintFor } from '../../lib/db/llm-credentials.js';
import { encrypt, decrypt } from '../../lib/encryption.js';

beforeAll(() => {
  process.env.JWT_SECRET ??= 'a-test-secret-that-is-long-enough-to-pass';
  process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
  process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
  process.env.APP_URL ??= 'http://localhost:5173';
  process.env.API_URL ??= 'http://localhost:3001';
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5433/test?sslmode=disable';
});

const OPENAI_KEY = 'sk-test-0000000000000000abcd';

describe('credential input', () => {
  it('accepts bedrock without an api key', () => {
    // Bedrock authenticates with the AWS credentials the process already has.
    const credential = readCredential({
      provider: 'bedrock',
      model: 'anthropic.claude-sonnet-4-5-v1:0',
    });

    expect(credential.apiKey).toBeNull();
  });

  it('accepts ollama without an api key', () => {
    const credential = readCredential({ provider: 'ollama', model: 'llama3.3' });
    expect(credential.apiKey).toBeNull();
  });

  it('rejects openai without an api key', () => {
    expect(() => readCredential({ provider: 'openai', model: 'gpt-4.1' })).toThrow(
      InvalidCredentialError
    );
  });

  it('rejects a provider it does not support', () => {
    expect(() => readCredential({ provider: 'cohere', model: 'command' })).toThrow(
      InvalidCredentialError
    );
  });

  it('rejects a base url that is not http', () => {
    expect(() =>
      readCredential({ provider: 'ollama', model: 'llama3.3', baseUrl: 'file:///etc/passwd' })
    ).toThrow(InvalidCredentialError);
  });
});

describe('stored keys', () => {
  it('stores only the last four characters as a hint', () => {
    const hint = hintFor(OPENAI_KEY);

    expect(hint).toBe('abcd');
    expect(OPENAI_KEY).toContain(hint);
    // The hint must not be enough to reconstruct anything.
    expect(hint.length).toBe(4);
  });

  it('decrypts a stored key for server-side use', () => {
    expect(decrypt(encrypt(OPENAI_KEY))).toBe(OPENAI_KEY);
  });

  it('is unreadable at rest without the encryption key', () => {
    const stored = encrypt(OPENAI_KEY);

    expect(stored).not.toContain(OPENAI_KEY);
    expect(stored).not.toContain('sk-test');
  });
});

describe('settings patch', () => {
  it('returns an empty patch for an empty body, leaving everything alone', () => {
    expect(readPatch({})).toEqual({});
  });

  it('rejects a region that is not one', () => {
    expect(() => readPatch({ defaultRegion: 'moon-base-1a' })).toThrow(InvalidSettingError);
    expect(readPatch({ defaultRegion: 'eu-west-1' })).toEqual({ defaultRegion: 'eu-west-1' });
  });

  it('rejects a reasoning scale it cannot map', () => {
    expect(() => readPatch({ reasoningScale: 'exhaustive' })).toThrow(InvalidSettingError);
    expect(readPatch({ reasoningScale: 'thorough' })).toEqual({ reasoningScale: 'thorough' });
  });

  it('treats a null budget as clearing it rather than as absent', () => {
    // The distinction matters: absent means "leave it", null means "remove it".
    expect(readPatch({ monthlyTokenBudget: null })).toEqual({ monthlyTokenBudget: null });
    expect(readPatch({})).not.toHaveProperty('monthlyTokenBudget');
  });

  it('rejects a budget that is not a positive whole number', () => {
    expect(() => readPatch({ monthlyTokenBudget: -1 })).toThrow(InvalidSettingError);
    expect(() => readPatch({ monthlyTokenBudget: 1.5 })).toThrow(InvalidSettingError);
  });
});
