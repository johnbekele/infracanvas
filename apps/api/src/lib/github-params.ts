/**
 * Validation for user-supplied values that are interpolated into GitHub API URLs.
 *
 * These routes proxy requests using the caller's OAuth token as a bearer
 * credential. Without validation, a value such as `../../user` traverses out of
 * the intended path and reaches an unrelated GitHub endpoint carrying that
 * token, so every segment must be constrained before it reaches a URL.
 */

export class InvalidGitHubParamError extends Error {
  constructor(
    readonly param: string,
    readonly reason: string
  ) {
    super(`Invalid ${param}: ${reason}`);
    this.name = 'InvalidGitHubParamError';
  }
}

/** GitHub logins: alphanumeric or hyphen, no leading or trailing hyphen, max 39. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Repository names: alphanumeric, hyphen, underscore, or dot, max 100. */
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Characters git forbids in ref names, plus space and the ASCII control range.
 * The control range is the point of this pattern, so the lint rule that guards
 * against accidental control characters does not apply.
 */
// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN = /[\u0000-\u0020~^:?*[\\\u007f]/;

function asString(value: unknown, param: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidGitHubParamError(param, 'must be a non-empty string');
  }
  return value;
}

export function assertOwner(value: unknown): string {
  const owner = asString(value, 'owner');
  if (!OWNER_PATTERN.test(owner)) {
    throw new InvalidGitHubParamError('owner', 'must be a valid GitHub login');
  }
  return owner;
}

export function assertRepo(value: unknown): string {
  const repo = asString(value, 'repo');
  if (!REPO_PATTERN.test(repo)) {
    throw new InvalidGitHubParamError('repo', 'must be a valid repository name');
  }
  // Rejected explicitly because both normalise to a parent path segment.
  if (repo === '.' || repo === '..') {
    throw new InvalidGitHubParamError('repo', 'must not be a relative path segment');
  }
  return repo;
}

/**
 * Branch names may contain `/`, so this validates each segment rather than
 * rejecting the separator outright.
 */
export function assertBranch(value: unknown): string {
  const branch = asString(value, 'branch');

  if (branch.length > 255) {
    throw new InvalidGitHubParamError('branch', 'must be 255 characters or fewer');
  }
  if (REF_FORBIDDEN.test(branch)) {
    throw new InvalidGitHubParamError('branch', 'contains a character git forbids in a ref name');
  }
  if (branch.includes('..') || branch.includes('@{')) {
    throw new InvalidGitHubParamError('branch', 'must not contain ".." or "@{"');
  }
  if (branch.endsWith('.lock') || branch.endsWith('/') || branch.startsWith('/')) {
    throw new InvalidGitHubParamError('branch', 'has an invalid ref boundary');
  }
  if (branch.split('/').some((segment) => segment === '' || segment.startsWith('.'))) {
    throw new InvalidGitHubParamError('branch', 'has an empty or dot-prefixed path segment');
  }
  return branch;
}

/**
 * Percent-encode a validated branch for use in a URL path while preserving the
 * `/` that separates ref segments.
 */
export function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

export interface RepoCoordinates {
  owner: string;
  repo: string;
}

export function assertRepoCoordinates(value: { owner?: unknown; repo?: unknown }): RepoCoordinates {
  return { owner: assertOwner(value.owner), repo: assertRepo(value.repo) };
}
