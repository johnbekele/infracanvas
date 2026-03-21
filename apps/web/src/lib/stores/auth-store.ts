// Authentication store
import { create } from 'zustand';
import { authApi } from '../api/client';

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

  // Actions
  checkAuth: () => Promise<void>;
  login: () => void;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true, // Start loading to check auth on mount
  error: null,
  hasGitHubToken: false,

  checkAuth: async () => {
    set({ isLoading: true, error: null });

    try {
      const status = await authApi.getStatus();

      if (status.authenticated && status.user) {
        set({
          user: status.user,
          isAuthenticated: true,
          hasGitHubToken: status.hasGitHubToken || false,
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

  login: () => {
    // Redirect to GitHub OAuth
    window.location.href = authApi.getOAuthUrl();
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
      error: null,
    });
  },

  clearError: () => {
    set({ error: null });
  },
}));
