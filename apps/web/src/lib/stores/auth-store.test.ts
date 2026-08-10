/**
 * What the store does when it cannot get an answer.
 *
 * The failure this covers looked like a session bug and was not one: a status
 * check refused by the rate limiter cleared the user, so the browser presented
 * a signed-out application while the cookie and the stored GitHub token were
 * both still valid, and the connection appeared not to persist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as client from '../api/client';
import { ApiError } from '../api/client';
import { useAuthStore } from './auth-store';

const getStatus = vi.hoisted(() => vi.fn());

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof client>()),
  authApi: {
    getStatus,
    getMethods: vi.fn(),
    logout: vi.fn(),
    getSignInUrl: () => '/api/auth/github',
  },
}));

const USER = {
  id: 'user-1',
  githubId: 42,
  githubUsername: 'johnbekele',
  githubAvatar: 'https://example.com/a.png',
};

const SIGNED_IN = {
  authenticated: true,
  user: USER,
  hasGitHubToken: true,
  authMethod: 'token' as const,
  tokenOrigin: 'gh-cli',
};

beforeEach(() => {
  // The store logs a failed check, which is right in a browser and only noise
  // in a test that is deliberately causing one.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getStatus.mockReset();
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    error: null,
    hasGitHubToken: false,
    authMethod: null,
    tokenOrigin: null,
    hasChecked: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a status check that cannot be answered', () => {
  it('leaves a signed-in user signed in when the request is rate limited', async () => {
    getStatus.mockResolvedValueOnce(SIGNED_IN);
    await useAuthStore.getState().checkAuth();

    getStatus.mockRejectedValueOnce(
      new ApiError('Too many requests', 429, { error: 'Too many requests', retryAfter: 900 })
    );
    await useAuthStore.getState().checkAuth();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user).toEqual(USER);
    // The GitHub connection is what the user notices losing.
    expect(state.hasGitHubToken).toBe(true);
  });

  it('says how long to wait rather than only that something failed', async () => {
    getStatus.mockRejectedValueOnce(
      new ApiError('Too many requests', 429, { error: 'Too many requests', retryAfter: 900 })
    );

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().error).toContain('15 minutes');
  });

  it('leaves the user signed in when the server cannot be reached at all', async () => {
    getStatus.mockResolvedValueOnce(SIGNED_IN);
    await useAuthStore.getState().checkAuth();

    getStatus.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('stops loading, so the interface does not hang on a spinner', async () => {
    getStatus.mockRejectedValueOnce(new ApiError('Too many requests', 429, {}));

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});

describe('a status check that is answered', () => {
  it('signs the user out when the server says there is no session', async () => {
    getStatus.mockResolvedValueOnce(SIGNED_IN);
    await useAuthStore.getState().checkAuth();

    getStatus.mockResolvedValueOnce({ authenticated: false });
    await useAuthStore.getState().checkAuth();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(state.hasGitHubToken).toBe(false);
  });

  it('records how the session was established', async () => {
    getStatus.mockResolvedValueOnce(SIGNED_IN);

    await useAuthStore.getState().checkAuth();

    expect(useAuthStore.getState().authMethod).toBe('token');
    expect(useAuthStore.getState().tokenOrigin).toBe('gh-cli');
  });
});

describe('how often the question is asked', () => {
  it('asks once when several callers ask at the same moment', async () => {
    getStatus.mockResolvedValue(SIGNED_IN);

    await Promise.all([
      useAuthStore.getState().checkAuth(),
      useAuthStore.getState().checkAuth(),
      useAuthStore.getState().checkAuth(),
    ]);

    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('does not ask again once it has an answer', async () => {
    getStatus.mockResolvedValue(SIGNED_IN);

    await useAuthStore.getState().ensureAuth();
    await useAuthStore.getState().ensureAuth();

    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('asks again when told to, so signing in takes effect', async () => {
    getStatus.mockResolvedValue(SIGNED_IN);

    await useAuthStore.getState().ensureAuth();
    await useAuthStore.getState().checkAuth();

    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('asks again after a failure, since nothing was learned the first time', async () => {
    getStatus.mockRejectedValueOnce(new ApiError('Too many requests', 429, {}));
    await useAuthStore.getState().ensureAuth();

    getStatus.mockResolvedValueOnce(SIGNED_IN);
    await useAuthStore.getState().ensureAuth();

    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
