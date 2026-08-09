// GitHub Store - Manages PAT and GitHub state
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { GitHubUser, GitHubRepo } from './types';

interface GitHubState {
  // Auth
  token: string | null;
  user: GitHubUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Repo selection
  selectedRepo: GitHubRepo | null;
  selectedBranch: string;

  // Actions
  setToken: (token: string) => Promise<void>;
  clearToken: () => void;
  setSelectedRepo: (repo: GitHubRepo | null) => void;
  setSelectedBranch: (branch: string) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setUser: (user: GitHubUser | null) => void;
}

export const useGitHubStore = create<GitHubState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      selectedRepo: null,
      selectedBranch: 'main',

      setToken: async (token: string) => {
        set({ token, isLoading: true, error: null });

        try {
          // Validate token by fetching user
          const response = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          });

          if (!response.ok) {
            throw new Error('Invalid token');
          }

          const user = await response.json();
          set({
            user,
            isAuthenticated: true,
            isLoading: false,
            error: null,
          });
        } catch (_error) {
          set({
            token: null,
            user: null,
            isAuthenticated: false,
            isLoading: false,
            error: 'Invalid GitHub token. Please check and try again.',
          });
        }
      },

      clearToken: () => {
        set({
          token: null,
          user: null,
          isAuthenticated: false,
          selectedRepo: null,
          selectedBranch: 'main',
          error: null,
        });
      },

      setSelectedRepo: (repo) => {
        set({
          selectedRepo: repo,
          selectedBranch: repo?.default_branch || 'main',
        });
      },

      setSelectedBranch: (branch) => {
        set({ selectedBranch: branch });
      },

      setError: (error) => {
        set({ error });
      },

      setLoading: (loading) => {
        set({ isLoading: loading });
      },

      setUser: (user) => {
        set({ user, isAuthenticated: Boolean(user) });
      },
    }),
    {
      name: 'infracanvas-github',
      partialize: (state) => ({
        token: state.token,
        selectedRepo: state.selectedRepo,
        selectedBranch: state.selectedBranch,
      }),
    }
  )
);
