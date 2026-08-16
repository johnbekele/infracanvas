/**
 * The checklist on a pull request is only worth anything if something other
 * than the author verified it. These functions let the orchestrator tick each
 * box from evidence in the diff and the commit log, so a box is ticked because
 * it is true rather than because a model said so.
 */

import { pathsCollide } from './conflicts';

/** Root files every lane touches eventually; a change to one is not a scope violation. */
const SHARED_FILES = ['.gitignore', 'AGENTS.md', 'CLAUDE.md'];

/**
 * Dependency manifests and lockfiles, matched by name at any depth: adding a
 * library is a normal part of implementing an issue, and in a monorepo the
 * manifest lives next to the package (`apps/api/package.json`), not only at the
 * root. Editing one to declare a needed dependency is never a scope violation.
 */
const DEPENDENCY_MANIFESTS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'uv.lock',
  'requirements.txt',
]);

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/** A file any issue may edit without declaring it: shared root files and dependency manifests. */
export function isSharedFile(path: string): boolean {
  return SHARED_FILES.includes(path) || DEPENDENCY_MANIFESTS.has(baseName(path));
}

/**
 * Did the branch change only files the issue declared, plus the shared files
 * everyone edits? A change outside both sets means the agent strayed from the
 * contract, and the scope box must not be ticked.
 */
export function scopeRespected(
  changedPaths: readonly string[],
  declaredPaths: readonly string[]
): boolean {
  return changedPaths.every((changed) => {
    if (isSharedFile(changed)) return true;
    return declaredPaths.some((declared) => pathsCollide(changed, declared));
  });
}

const AI_TRAILER = /^(Co-Authored-By:\s*(Claude|Cursor|Copilot|AI\b)|Generated with)/im;

/** True if any commit message carries an assistant attribution trailer. */
export function hasAiTrailer(messages: readonly string[]): boolean {
  return messages.some((m) => AI_TRAILER.test(m));
}

/**
 * Added lines that look like a committed credential. Deliberately conservative:
 * it exists to stop an obvious leak reaching a public PR, not to replace
 * gitleaks, which Gate 1 and Gate 5 still run. Only added (`+`) lines count.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style key
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/i,
];

/** Scan the added lines of a unified diff for anything resembling a secret. */
export function hasSecret(diff: string): boolean {
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    if (SECRET_PATTERNS.some((p) => p.test(added))) return true;
  }
  return false;
}
