/**
 * Reading a repository through the GitHub API rather than cloning it.
 *
 * A clone costs a full checkout on disk and several seconds before any analysis
 * can start; the profile only needs the file listing and a handful of manifest
 * files, which is four requests and no disk at all. Deep analysis -- parsing
 * every source file into a symbol graph -- does need a working copy, and that
 * belongs to the ingestion engine rather than here.
 */
import { encodeBranch } from '../github-params.js';

const GITHUB_API = 'https://api.github.com';

/** Bounds on how much of a repository is read, so one huge one cannot exhaust memory. */
export const LIMITS = {
  /** A manifest larger than this is not a manifest anyone wrote by hand. */
  maxManifestBytes: 512 * 1024,
  /** Enough for a large monorepo; beyond it the extra components add nothing. */
  maxManifests: 40,
  maxDockerfiles: 20,
} as const;

export class GitHubSourceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitHubSourceError';
  }
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface RepositoryTree {
  entries: TreeEntry[];
  /**
   * GitHub caps a recursive tree response. When set, the listing is incomplete
   * and any conclusion drawn from an absence of files is unsound.
   */
  truncated: boolean;
}

interface FetchOptions {
  token: string;
  owner: string;
  repo: string;
}

async function githubRequest<T>(url: string, token: string, what: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new GitHubSourceError(
      `GitHub returned ${response.status} while fetching ${what}`,
      response.status
    );
  }

  return (await response.json()) as T;
}

/** Resolve a ref to the commit it points at, so the profile records exact code. */
export async function resolveCommit(options: FetchOptions & { ref: string }): Promise<string> {
  const { token, owner, repo, ref } = options;

  const commit = await githubRequest<{ sha: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${encodeBranch(ref)}`,
    token,
    `the commit for ${ref}`
  );

  return commit.sha;
}

export async function fetchTree(
  options: FetchOptions & { commitSha: string }
): Promise<RepositoryTree> {
  const { token, owner, repo, commitSha } = options;

  const tree = await githubRequest<{
    tree: TreeEntry[];
    truncated: boolean;
  }>(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
    token,
    'the file tree'
  );

  return { entries: tree.tree ?? [], truncated: tree.truncated === true };
}

/** Bytes of code per language, as GitHub classifies them. */
export async function fetchLanguages(options: FetchOptions): Promise<Record<string, number>> {
  const { token, owner, repo } = options;

  return githubRequest<Record<string, number>>(
    `${GITHUB_API}/repos/${owner}/${repo}/languages`,
    token,
    'the language breakdown'
  );
}

/**
 * Fetch a blob's text by its object SHA.
 *
 * Addressed by SHA rather than path so the content is pinned to the commit that
 * was resolved, and cannot drift if the branch moves mid-analysis.
 */
export async function fetchBlobText(options: FetchOptions & { sha: string }): Promise<string> {
  const { token, owner, repo, sha } = options;

  const blob = await githubRequest<{ content: string; encoding: string }>(
    `${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${sha}`,
    token,
    'a file'
  );

  if (blob.encoding !== 'base64') {
    throw new GitHubSourceError(`Unexpected blob encoding: ${blob.encoding}`, 502);
  }

  return Buffer.from(blob.content, 'base64').toString('utf8');
}
