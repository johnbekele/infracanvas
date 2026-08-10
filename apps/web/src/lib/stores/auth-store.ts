// Authentication store
import { create } from 'zustand';
import { authApi, type AuthMethod, type AuthMethodId } from '../api/client';

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

  // Actions
  checkAuth: () => Promise<void>;
  loadMethods: () => Promise<void>;
  login: (method?: AuthMethodId) => void;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true, // Start loading to check auth on mount
  error: null,
  hasGitHubToken: false,
  authMethod: null,
  tokenOrigin: null,
  methods: [],
  defaultMethod: null,

  checkAuth: async () => {
    set({ isLoading: true, error: null });

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
        });
      } else {
        set({
          user: null,
          isAuthenticated: false,
          hasGitHubToken: false,
          isLoading: false,
        });
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      set({
        user: null,
        isAuthenticated: false,
        hasGitHubToken: false,
        isLoading: false,
        error: 'Failed to check authentication status',
      });
    }
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
    });
  },

  clearError: () => {
    set({ error: null });
  },
}));
