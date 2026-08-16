/**
 * Two issues that touch the same file are not independent, and running them in
 * parallel is a merge conflict the moment both branches change that file. Git
 * gives no warning until the second merge.
 *
 * The defence is the contract itself: Gate 0 forces every spec to mark each
 * path CREATE, MODIFY or DELETE in its `### Files` section, so the blast radius
 * is declared. This module reads that declaration and answers one question —
 * would starting this issue collide with one already running?
 */

import type { FileChange } from './types';

const FILES_HEADING = /^###\s+Files\s*$/;
const NEXT_HEADING = /^###\s+/;

/**
 * A `### Files` bullet, e.g.
 *   - MODIFY `turbo.json` - build workspace dependencies first
 *   - CREATE `packages/agent-loop/src/queue.ts` — eligibility
 * The path is whatever sits in the first backtick pair; the dash prose after it
 * is ignored. A bullet without a backticked path is skipped rather than guessed
 * at, because a wrong path here silently disables overlap protection.
 */
const BULLET = /^\s*[-*]\s*(CREATE|MODIFY|DELETE)\b[^`]*`([^`]+)`/i;

/** Extract the declared file changes from a spec body. */
export function parseFilesSection(body: string): FileChange[] {
  const lines = body.split('\n');
  const changes: FileChange[] = [];
  let inSection = false;

  for (const line of lines) {
    if (FILES_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && NEXT_HEADING.test(line)) break;
    if (!inSection) continue;

    const match = BULLET.exec(line);
    if (!match) continue;
    changes.push({
      op: match[1].toUpperCase() as FileChange['op'],
      path: normalise(match[2]),
    });
  }

  return changes;
}

/** Just the paths, deduplicated, for overlap tests. */
export function declaredPaths(body: string): string[] {
  return [...new Set(parseFilesSection(body).map((c) => c.path))];
}

/**
 * Strip a leading `./`, collapse `//`, and drop a trailing slash, so
 * `./apps/api/` and `apps/api` compare equal. Paths are treated as repository
 * relative throughout.
 */
function normalise(path: string): string {
  return path
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/**
 * Does one path contain or equal the other, treating each as a repository path?
 * `apps/api` collides with `apps/api/src/index.ts`, and a bare directory
 * collides with anything beneath it, but `apps/api` does not collide with
 * `apps/api-client` — the boundary is a path segment, not a string prefix.
 */
export function pathsCollide(a: string, b: string): boolean {
  // Compare on a trailing-slash-insensitive form, so a declared `db/` and a
  // parsed `db/x.sql` collide regardless of how each was written.
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/\/+$/, '');
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return longer.startsWith(`${shorter}/`);
}

/**
 * Would starting an issue with `candidate` paths collide with the union of
 * `running` paths already claimed by live lanes?
 */
export function overlaps(candidate: string[], running: string[]): boolean {
  for (const c of candidate) {
    for (const r of running) {
      if (pathsCollide(c, r)) return true;
    }
  }
  return false;
}
