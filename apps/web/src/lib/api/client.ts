// API client for backend communication
// Uses relative URLs - works on both localhost and Vercel

interface FetchOptions extends RequestInit {
  skipAuth?: boolean;
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Make an authenticated API request
 */
async function apiFetch<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const { skipAuth, ...fetchOptions } = options;

  const response = await fetch(`/api${endpoint}`, {
    ...fetchOptions,
    credentials: 'include', // Include cookies for session
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error || `API error: ${response.status}`,
      response.status,
      data
    );
  }

  return response.json();
}

// Auth API
export const authApi = {
  /**
   * Get the GitHub OAuth URL to redirect to
   */
  getOAuthUrl(): string {
    return '/api/auth/github';
  },

  /**
   * Check authentication status
   */
  async getStatus(): Promise<{
    authenticated: boolean;
    user?: {
      id: string;
      githubId: number;
      githubUsername: string;
      githubAvatar: string;
      name?: string;
      email?: string;
    };
    hasGitHubToken?: boolean;
  }> {
    return apiFetch('/auth/status');
  },

  /**
   * Logout
   */
  async logout(): Promise<void> {
    await apiFetch('/auth/logout', { method: 'POST' });
  },
};

// GitHub API (proxied through backend)
export const githubApi = {
  /**
   * Get authenticated user
   */
  async getUser() {
    return apiFetch<{
      login: string;
      id: number;
      avatar_url: string;
      name: string | null;
      email: string | null;
    }>('/github/user');
  },

  /**
   * List user repositories
   */
  async listRepos() {
    return apiFetch<Array<{
      id: number;
      name: string;
      full_name: string;
      private: boolean;
      description: string | null;
      default_branch: string;
      html_url: string;
      clone_url: string;
      pushed_at: string;
      owner: {
        login: string;
        avatar_url: string;
      };
    }>>('/github/repos');
  },

  /**
   * Create a new repository
   */
  async createRepo(name: string, description?: string, isPrivate?: boolean) {
    return apiFetch<{
      id: number;
      name: string;
      full_name: string;
      html_url: string;
      default_branch: string;
    }>('/github/repos', {
      method: 'POST',
      body: JSON.stringify({ name, description, isPrivate }),
    });
  },

  /**
   * List branches for a repository
   */
  async listBranches(owner: string, repo: string) {
    return apiFetch<Array<{
      name: string;
      commit: { sha: string };
      protected: boolean;
    }>>(`/github/branches?owner=${owner}&repo=${repo}`);
  },

  /**
   * Create a new branch
   */
  async createBranch(owner: string, repo: string, branchName: string, fromBranch: string) {
    return apiFetch(`/github/branches?owner=${owner}&repo=${repo}`, {
      method: 'POST',
      body: JSON.stringify({ branchName, fromBranch }),
    });
  },

  /**
   * Push files to a repository
   */
  async pushFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: Array<{ path: string; content: string }>
  ) {
    return apiFetch<{
      success: boolean;
      message: string;
      commitUrl: string;
      commitSha: string;
    }>('/github/push', {
      method: 'POST',
      body: JSON.stringify({ owner, repo, branch, message, files }),
    });
  },
};

export { ApiError };
