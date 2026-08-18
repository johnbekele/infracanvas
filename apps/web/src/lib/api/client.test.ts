/**
 * The client must echo the CSRF cookie into X-CSRF-Token on state-changing
 * requests. Without that header a SameSite=None session cookie is forgeable
 * from any origin that can trigger a credentialed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, CSRF_COOKIE } from './client';

describe('apiFetch CSRF header', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    let cookieJar = '';
    vi.stubGlobal('document', {
      get cookie() {
        return cookieJar;
      },
      set cookie(value: string) {
        cookieJar = value;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the client echoes the cookie on a non-safe request', async () => {
    document.cookie = `${CSRF_COOKIE}=csrf-token-value`;

    await apiFetch('/repositories', { method: 'POST', body: '{}' });
    const postHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(postHeaders['X-CSRF-Token']).toBe('csrf-token-value');

    fetchMock.mockClear();
    await apiFetch('/auth/status');
    const getHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(getHeaders['X-CSRF-Token']).toBeUndefined();
  });
});
