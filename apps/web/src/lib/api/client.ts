// API client for backend communication.
// A hosted build must set VITE_API_URL to the deployed apps/api origin. The
// relative fallback only works under `pnpm dev`, where Vite proxies /api to the
// local server; nothing serves /api in a static deployment.

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

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

if (import.meta.env.PROD && !API_BASE_URL) {
  console.warn('VITE_API_URL is unset; API requests will fail against a static deployment.');
}

/**
 * Make an authenticated API request
 */
export async function apiFetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const { skipAuth: _skipAuth, ...fetchOptions } = options;

  // Use full URL for Render backend, or relative /api for local proxy
  const url = API_BASE_URL ? `${API_BASE_URL}${endpoint}` : `/api${endpoint}`;

  const response = await fetch(url, {
    ...fetchOptions,
    credentials: 'include', // Include cookies for session
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers,
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || `API error: ${response.status}`, response.status, data);
  }

  // A 204 carries no body, so parsing it as JSON would throw on a request that
  // in fact succeeded.
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export type AuthMethodId = 'oauth' | 'token';

export interface AuthMethod {
  id: AuthMethodId;
  available: boolean;
  reason?: string;
  description: string;
}

// Auth API
export const authApi = {
  /**
   * Where to send the browser to sign in.
   *
   * Sign-in is a redirect rather than a fetch because the OAuth path leaves the
   * application entirely, so the method travels as a query parameter.
   */
  getSignInUrl(method?: AuthMethodId): string {
    const base = API_BASE_URL ? `${API_BASE_URL}/auth/github` : '/api/auth/github';
    return method ? `${base}?method=${method}` : base;
  },

  /** What this caller can actually use. Availability depends on where they are. */
  async getMethods(): Promise<{ methods: AuthMethod[]; default: AuthMethodId }> {
    return apiFetch('/auth/methods');
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
    authMethod?: AuthMethodId;
    tokenOrigin?: string;
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
    return apiFetch<
      Array<{
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
      }>
    >('/github/repos');
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
    return apiFetch<
      Array<{
        name: string;
        commit: { sha: string };
        protected: boolean;
      }>
    >(`/github/branches?owner=${owner}&repo=${repo}`);
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
