/**
 * A claim makes "I am working this issue" visible in two places: the
 * `status:in-progress` label, so another operator's queue skips it, and a local
 * lockfile, so this loop's own three lanes never collide even before a label
 * round-trips. Both are released on every exit path — success, block, or crash
 * recovery — because a claim that outlives its work strands an issue nobody is
 * actually doing.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GitHub } from './gh';
import type { Claim } from './types';

const IN_PROGRESS = 'status:in-progress';

export class ClaimStore {
  private readonly dir: string;

  constructor(
    stateDir: string,
    private readonly github: GitHub,
    private readonly assignee: string
  ) {
    this.dir = join(stateDir, 'claims');
    mkdirSync(this.dir, { recursive: true });
  }

  private file(issue: number): string {
    return join(this.dir, `${issue}.json`);
  }

  /** Issue numbers this loop currently holds, read from the lockfiles on disk. */
  claimedIssues(): Set<number> {
    const claims = new Set<number>();
    for (const name of readdirSync(this.dir)) {
      const match = /^(\d+)\.json$/.exec(name);
      if (match) claims.add(Number.parseInt(match[1], 10));
    }
    return claims;
  }

  /** The declared paths of every held claim, for the overlap check. */
  runningPaths(): string[] {
    const paths: string[] = [];
    for (const issue of this.claimedIssues()) {
      const claim = this.read(issue);
      if (claim) paths.push(...claim.paths);
    }
    return paths;
  }

  private read(issue: number): Claim | null {
    const file = this.file(issue);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Claim;
    } catch {
      return null;
    }
  }

  /**
   * Take the claim. Writes the lockfile first so a crash between the two steps
   * leaves a stale lockfile (harmless, skipped next pass) rather than a labelled
   * issue no lockfile remembers.
   */
  async acquire(claim: Claim): Promise<void> {
    if (existsSync(this.file(claim.issue))) {
      throw new Error(`issue #${claim.issue} is already claimed locally`);
    }
    writeFileSync(this.file(claim.issue), JSON.stringify(claim, null, 2));
    await this.github.addLabels(claim.issue, [IN_PROGRESS]);
    await this.github.assign(claim.issue, this.assignee);
  }

  /** Release the claim. Removing the label first, then the lockfile, so a failure mid-release still frees the queue. */
  async release(issue: number): Promise<void> {
    await this.github.removeLabels(issue, [IN_PROGRESS]);
    const file = this.file(issue);
    if (existsSync(file)) rmSync(file);
  }
}
