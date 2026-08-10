import { describe, expect, it, vi, afterEach } from 'vitest';
import { verifyCredential } from './verify.js';

const KEY = 'sk-secret-value-9999';

afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWith(status: number, body = ''): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status }))
  );
}

describe('verifyCredential', () => {
  it('reports success when the provider answers', async () => {
    respondWith(200, '{"data":[]}');

    await expect(
      verifyCredential({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY })
    ).resolves.toEqual({ ok: true, model: 'gpt-4.1' });
  });

  it('reports a verification failure without including the key in the message', async () => {
    // A provider that echoes the request back on an error would otherwise put
    // the key straight into a message the interface displays and the logs keep.
    respondWith(401, JSON.stringify({ error: `invalid key ${KEY}` }));

    const result = await verifyCredential({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain(KEY);
      expect(result.error).toMatch(/rejected the API key/);
    }
  });

  it('does not leak the key when the request throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED with header ${KEY}`);
      })
    );

    const result = await verifyCredential({ provider: 'ollama', model: 'llama3.3' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(KEY);
  });

  it('refuses a provider that needs a key before making any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyCredential({ provider: 'anthropic', model: 'claude-sonnet-4-5' });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not claim to have verified AWS credentials it cannot see', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Bedrock authenticates through the process's AWS credentials, which are a
    // separate connection with their own scopes.
    await expect(
      verifyCredential({ provider: 'bedrock', model: 'anthropic.claude-sonnet-4-5-v1:0' })
    ).resolves.toEqual({ ok: true, model: 'anthropic.claude-sonnet-4-5-v1:0' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives up rather than holding the request open on a provider that never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          })
      )
    );

    const pending = verifyCredential({ provider: 'openai', model: 'gpt-4.1', apiKey: KEY });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result).toEqual({ ok: false, error: 'OpenAI did not respond within 10 seconds.' });
    vi.useRealTimers();
  });

  it('reports an unreachable local model server as a connection problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );

    const result = await verifyCredential({
      provider: 'ollama',
      model: 'llama3.3',
      baseUrl: 'http://localhost:9999',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Check the base URL/);
  });
});
