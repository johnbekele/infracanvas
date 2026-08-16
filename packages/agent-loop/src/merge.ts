/**
 * The one predicate that decides whether the loop presses merge. It is kept
 * pure and small on purpose: this is the single most consequential decision the
 * loop makes, so it must be trivially readable and fully unit-tested, with no
 * network call hidden inside it.
 *
 * Nothing here consults the risk tier. Per the operator's configuration the
 * loop merges every tier including tier 1; the tier is recorded in the run log
 * for audit, but it does not gate the merge. The gates do.
 */

import type { CheckRun } from './types';

export interface MergeInput {
  /** GitHub's mergeability verdict. Anything but a clean MERGEABLE blocks. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** Every required check on the pull request. */
  checks: readonly CheckRun[];
  /** Count of review threads still open; the ruleset requires them resolved. */
  unresolvedThreads: number;
  /** Only pull requests the loop itself opened are ever merged. */
  isAgentLoop: boolean;
  /** A draft is never merged. */
  isDraft: boolean;
}

export interface MergeDecision {
  merge: boolean;
  reason: string;
}

/**
 * Merge only when every condition holds. The first failing condition names
 * itself, so the run log records why a pull request waited rather than merged.
 */
export function mergeDecision(input: MergeInput): MergeDecision {
  if (!input.isAgentLoop) {
    return { merge: false, reason: 'not an agent-loop pull request; left for a human' };
  }
  if (input.isDraft) {
    return { merge: false, reason: 'pull request is a draft' };
  }
  if (input.mergeable === 'CONFLICTING') {
    return { merge: false, reason: 'merge conflict with the base branch' };
  }
  if (input.mergeable === 'UNKNOWN') {
    return { merge: false, reason: 'mergeability not yet computed by GitHub' };
  }
  if (input.unresolvedThreads > 0) {
    return { merge: false, reason: `${input.unresolvedThreads} unresolved review thread(s)` };
  }

  const failing = input.checks.filter((c) => c.state === 'fail');
  if (failing.length > 0) {
    return { merge: false, reason: `failing checks: ${failing.map((c) => c.name).join(', ')}` };
  }

  const pending = input.checks.filter((c) => c.state === 'pending');
  if (pending.length > 0) {
    return { merge: false, reason: `${pending.length} check(s) still running` };
  }

  if (input.checks.length === 0) {
    return { merge: false, reason: 'no checks reported yet' };
  }

  return { merge: true, reason: 'mergeable, all required checks green, threads resolved' };
}
