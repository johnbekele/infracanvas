/**
 * Isolated working trees, one per issue. Wraps scripts/agent/new-worktree.sh
 * rather than reimplementing it, so the port allocation and commit-identity
 * guard that script already got right are not duplicated and left to drift.
 *
 * Trees live in a sibling `<repo>-wt/` directory, never under the repository
 * root, because a nested tree is a second checkout that `git add -A` would
 * commit into the first.
 */

import { basename, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { capture, run } from './exec';

export interface Worktree {
  slug: string;
  branch: string;
  path: string;
}

export class Worktrees {
  /** @param mainCheckout absolute path to the primary (non-linked) checkout. */
  constructor(private readonly mainCheckout: string) {}

  /** Where new-worktree.sh will place a tree for `slug`, computed the same way it does. */
  pathFor(slug: string): string {
    const parent = dirname(this.mainCheckout);
    const trees = join(parent, `${basename(this.mainCheckout)}-wt`);
    return join(trees, slug);
  }

  /** Create a tree on `branch`, installing dependencies. Idempotent-hostile: fails if it exists. */
  async create(slug: string, branch: string): Promise<Worktree> {
    const script = join(this.mainCheckout, 'scripts/agent/new-worktree.sh');
    const result = await run('bash', [script, slug, branch], { cwd: this.mainCheckout });
    if (result.code !== 0) {
      throw new Error(`new-worktree.sh failed for ${slug} (exit ${result.code})`);
    }
    const path = this.pathFor(slug);
    if (!existsSync(path)) {
      throw new Error(`worktree script reported success but ${path} does not exist`);
    }
    return { slug, branch, path };
  }

  /** Remove a tree and prune the administrative entry, after its PR merges or the issue is abandoned. */
  async remove(slug: string): Promise<void> {
    const path = this.pathFor(slug);
    await capture('git', ['-C', this.mainCheckout, 'worktree', 'remove', '--force', path]);
    await capture('git', ['-C', this.mainCheckout, 'worktree', 'prune']);
  }
}

/** Resolve the primary checkout from wherever the loop was started. */
export async function mainCheckoutPath(startDir: string): Promise<string> {
  const { code, stdout } = await capture('git', ['rev-parse', '--git-common-dir'], {
    cwd: startDir,
  });
  if (code !== 0) throw new Error('not inside a git repository');
  const commonDir = stdout.trim();
  // --git-common-dir is `<repo>/.git`; its parent is the primary checkout even
  // when the loop is started from a linked worktree.
  const absolute = commonDir.startsWith('/') ? commonDir : join(startDir, commonDir);
  return dirname(absolute);
}
