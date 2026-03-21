// GitHub Types for InfraCanvas

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  name: string | null;
  email: string | null;
}

export interface GitHubRepo {
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
}

export interface GitHubBranch {
  name: string;
  commit: {
    sha: string;
  };
  protected: boolean;
}

export interface GitHubContent {
  path: string;
  sha?: string;
  content: string;
  message: string;
  branch: string;
}

export interface PushResult {
  success: boolean;
  message: string;
  commitUrl?: string;
  error?: string;
}

export interface GitHubSettings {
  token: string | null;
  lastRepo?: string;
  lastBranch?: string;
}
