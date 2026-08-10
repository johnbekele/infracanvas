// Authentication store
import { create } from 'zustand';
import { ApiError, authApi, type AuthMethod, type AuthMethodId } from '../api/client';

export interface User {
  id: string;
  githubId: number;
  githubUsername: string;
  githubAvatar: string;
  name?: string;
  email?: string;
}

interface AuthState {
  // State
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  hasGitHubToken: boolean;
  /** Which sign-in path issued the current session, once one exists. */
  authMethod: AuthMethodId | null;
  /** Where a local token came from, so a surprising account is traceable. */
  tokenOrigin: string | null;
  methods: AuthMethod[];
  defaultMethod: AuthMethodId | null;
  /** Whether the server has answered the status question at least once. */
  hasChecked: boolean;

  // Actions
  checkAuth: () => Promise<void>;
  ensureAuth: () => Promise<void>;
  loadMethods: () => Promise<void>;
  login: (method?: AuthMethodId) => void;
  logout: () => Promise<void>;
  clearError: () => void;
}

/**
 * The status request currently in the air, if any.
 *
 * Several components ask on mount and React runs effects twice in development,
 * so without this one page visit spends several requests on the same question.
 */
let inFlight: Promise<void> | null = null;

/** What to tell the user about a status check that could not be completed. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) {
    const seconds = (error.data as { retryAfter?: number } | undefined)?.retryAfter;
    const minutes = seconds ? Math.ceil(seconds / 60) : null;
    return minutes
      ? `Too many requests. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
      : 'Too many requests. Try again shortly.';
  }

  return 'Could not reach the server to confirm you are signed in.';
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true, // Start loading to check auth on mount
  error: null,
  hasGitHubToken: false,
  authMethod: null,
  tokenOrigin: null,
  methods: [],
  defaultMethod: null,
  hasChecked: false,

  checkAuth: async () => {
    if (inFlight) return inFlight;

    set({ isLoading: true, error: null });

    inFlight = (async () => {
      try {
        const status = await authApi.getStatus();

        if (status.authenticated && status.user) {
          set({
            user: status.user,
            isAuthenticated: true,
            hasGitHubToken: status.hasGitHubToken || false,
            authMethod: status.authMethod ?? null,
            tokenOrigin: status.tokenOrigin ?? null,
            isLoading: false,
            hasChecked: true,
          });
        } else {
          set({
            user: null,
            isAuthenticated: false,
            hasGitHubToken: false,
            authMethod: null,
            tokenOrigin: null,
            isLoading: false,
            hasChecked: true,
          });
        }
      } catch (error) {
        // A question that could not be asked is not an answer of "no". This
        // used to clear the session on any failure, so one rate-limited request
        // or a moment offline presented as being signed out and disconnected
        // from GitHub, while the cookie and the stored token were both intact.
        console.error('Auth check failed:', error);
        set({ isLoading: false, error: messageFor(error) });
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  },

  /** Ask once per page load. Repeat visits to a route read what is already here. */
  ensureAuth: async () => {
    if (get().hasChecked) return;
    await get().checkAuth();
  },

  loadMethods: async () => {
    try {
      const { methods, default: preferred } = await authApi.getMethods();
      set({ methods, defaultMethod: preferred });
    } catch {
      // An older API has no /auth/methods. Leaving the list empty makes the
      // login button fall back to a plain sign-in, which is what it did before.
      set({ methods: [], defaultMethod: null });
    }
  },

  login: (method) => {
    window.location.href = authApi.getSignInUrl(method);
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch (error) {
      console.error('Logout error:', error);
    }

    set({
      user: null,
      isAuthenticated: false,
      hasGitHubToken: false,
      authMethod: null,
      tokenOrigin: null,
      error: null,
      hasChecked: true,
    });
  },

  clearError: () => {
    set({ error: null });
  },
}));
