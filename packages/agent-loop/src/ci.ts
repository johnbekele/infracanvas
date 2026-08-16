/**
 * Waiting on CI. The merge predicate in merge.ts decides what a set of checks
 * means; this module's only job is to poll GitHub until that set has settled —
 * no check still pending — or a deadline passes.
 */

import type { GitHub } from './gh';
import type { CheckRun } from './types';

export interface WatchResult {
  checks: CheckRun[];
  /** True if checks settled; false if the deadline passed with some still pending. */
  settled: boolean;
}

export interface WatchOptions {
  timeoutMs: number;
  pollMs: number;
  /** Called after each poll, so the supervisor can log progress. */
  onPoll?: (checks: CheckRun[]) => void;
}

/** Poll until every check has passed, failed, or skipped — or the deadline passes. */
export async function watchChecks(
  github: GitHub,
  pr: number,
  options: WatchOptions
): Promise<WatchResult> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const checks = await github.pullRequestChecks(pr);
    options.onPoll?.(checks);

    const pending = checks.filter((c) => c.state === 'pending');
    const settled = checks.length > 0 && pending.length === 0;
    if (settled) return { checks, settled: true };

    // A failure is terminal: no point waiting for the rest once one required
    // check is red, since the merge cannot proceed regardless.
    if (checks.some((c) => c.state === 'fail')) return { checks, settled: true };

    if (Date.now() >= deadline) return { checks, settled: false };
    await new Promise((r) => setTimeout(r, options.pollMs));
  }
}
