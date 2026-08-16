/**
 * The merge train: drain a backlog of open pull requests into their base branch,
 * one at a time, doing it properly.
 *
 * "Properly" means: never merge a draft, a conflict, or a red build; bring a
 * branch that fell behind up to date and re-run its checks before merging; and,
 * because every merge leaves the siblings behind under a strict-status ruleset,
 * process them in order so each one is updated against the merges that landed
 * before it. Anything that cannot merge cleanly is skipped with a named reason,
 * never forced.
 *
 * The selection is pure and tested (`selectTrainPRs`); the orchestration around
 * it reuses the same primitives the issue loop uses — `updateBranch`,
 * `watchChecks`, `mergeDecision`, `squashMerge` — so there is one implementation
 * of the consequential parts, not two.
 */

import { watchChecks } from './ci';
import type { GitHub } from './gh';
import * as log from './log';
import { mergeDecision } from './merge';

export interface TrainCandidate {
  number: number;
  title: string;
  baseRefName: string;
  isDraft: boolean;
  labels: readonly string[];
}

export interface TrainFilter {
  /** Only pull requests targeting this branch are drained. */
  baseBranch: string;
  /** Include tier:1 / needs:security-review pull requests (unreviewed). */
  includeTier1: boolean;
  /** Include dependabot (`dependencies`) pull requests. */
  includeDeps: boolean;
  /**
   * Include pull requests the autonomous issue loop opened (`agent-loop`). Off by
   * default: that loop drives its own pull requests to merge, so a train running
   * alongside it must not fight over the same ones.
   */
  includeAgentLoop: boolean;
  /** When set, exactly these numbers are attempted and the label filters are ignored. */
  onlyNumbers?: readonly number[];
}

/** Labels that mark a change as needing a human security review before merge. */
const TIER1_LABELS = ['tier:1', 'needs:security-review'];
const AGENT_LOOP_LABEL = 'agent-loop';

/**
 * The subset of open pull requests the train will attempt, in ascending number
 * order. Ordering matters: the train merges in this order, so oldest-first keeps
 * the base moving forward predictably.
 */
export function selectTrainPRs(
  prs: readonly TrainCandidate[],
  filter: TrainFilter
): TrainCandidate[] {
  const ordered = [...prs].sort((a, b) => a.number - b.number);

  if (filter.onlyNumbers && filter.onlyNumbers.length > 0) {
    const wanted = new Set(filter.onlyNumbers);
    return ordered.filter((pr) => wanted.has(pr.number));
  }

  return ordered.filter((pr) => {
    if (pr.baseRefName !== filter.baseBranch) return false;
    if (pr.isDraft) return false;
    const labels = new Set(pr.labels);
    if (!filter.includeTier1 && TIER1_LABELS.some((l) => labels.has(l))) return false;
    if (!filter.includeDeps && labels.has('dependencies')) return false;
    if (!filter.includeAgentLoop && labels.has(AGENT_LOOP_LABEL)) return false;
    return true;
  });
}

export type TrainOutcome =
  | 'merged'
  | 'ready' // dry run: would merge now
  | 'conflict'
  | 'failing'
  | 'timed-out'
  | 'blocked'
  | 'skipped';

export interface TrainResult {
  number: number;
  title: string;
  outcome: TrainOutcome;
  reason: string;
}

export interface TrainOptions {
  filter: TrainFilter;
  /** Inspect and report only; change nothing. */
  dryRun: boolean;
  /** How long to wait for a pull request's checks to settle, in ms. */
  ciTimeoutMs: number;
  ciPollMs: number;
  /** How long to let GitHub finish computing mergeability, in ms. */
  settleTimeoutMs: number;
  /** Pause after a branch update before re-watching CI, in ms. */
  rerunSettleMs: number;
  /** How many times to resync a branch that keeps falling behind before giving up. */
  maxSyncs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn a `mergeDecision` refusal into a train outcome, so the summary groups a
 * conflict apart from a red build apart from an unresolved thread.
 */
function classifyRefusal(reason: string): TrainOutcome {
  if (reason.includes('conflict')) return 'conflict';
  if (reason.includes('failing checks')) return 'failing';
  if (reason.includes('still running') || reason.includes('not yet computed')) return 'timed-out';
  return 'blocked';
}

/** Inspect one pull request and report what the train would do, changing nothing. */
async function planOne(github: GitHub, pr: TrainCandidate): Promise<TrainResult> {
  const done = (outcome: TrainOutcome, reason: string): TrainResult => ({
    number: pr.number,
    title: pr.title,
    outcome,
    reason,
  });

  const state = await github.settledPullRequestState(pr.number);
  if (state.isDraft) return done('skipped', 'draft');
  if (state.mergeable === 'CONFLICTING') return done('conflict', 'merge conflict with base');
  if (state.mergeStateStatus === 'BEHIND') {
    return done('ready', 'behind base — would update, wait for CI, then squash-merge');
  }

  const checks = await github.pullRequestChecks(pr.number);
  const failing = checks.filter((c) => c.state === 'fail');
  if (failing.length > 0) {
    return done('failing', `failing: ${failing.map((c) => c.name).join(', ')}`);
  }
  const pending = checks.filter((c) => c.state === 'pending');
  if (pending.length > 0) return done('ready', `${pending.length} check(s) running — would wait`);
  if (state.mergeStateStatus === 'BLOCKED') return done('blocked', 'blocked by branch protection');
  return done('ready', 'would squash-merge now');
}

/** Drive one pull request to a merge, updating and re-checking as needed. */
async function mergeOne(
  github: GitHub,
  pr: TrainCandidate,
  options: TrainOptions
): Promise<TrainResult> {
  const done = (outcome: TrainOutcome, reason: string): TrainResult => ({
    number: pr.number,
    title: pr.title,
    outcome,
    reason,
  });

  for (let sync = 0; ; sync += 1) {
    let state = await github.settledPullRequestState(pr.number, {
      timeoutMs: options.settleTimeoutMs,
    });
    if (state.isDraft) return done('skipped', 'draft');
    if (state.mergeable === 'CONFLICTING') return done('conflict', 'merge conflict with base');

    if (state.mergeStateStatus === 'BEHIND') {
      if (sync >= options.maxSyncs) return done('timed-out', 'kept falling behind base');
      log.info(`  #${pr.number} behind base; updating branch`);
      await github.updateBranch(pr.number);
      await delay(options.rerunSettleMs);
      continue;
    }

    log.info(`  #${pr.number} waiting for checks`);
    const watch = await watchChecks(github, pr.number, {
      timeoutMs: options.ciTimeoutMs,
      pollMs: options.ciPollMs,
    });
    if (!watch.settled) {
      const pending = watch.checks.filter((c) => c.state === 'pending').length;
      return done('timed-out', `${pending} check(s) still pending after the CI budget`);
    }

    // CI may have taken long enough that a sibling merged and left this behind
    // again; re-read before deciding, and resync once more if so.
    state = await github.settledPullRequestState(pr.number, { timeoutMs: options.settleTimeoutMs });
    if (state.mergeStateStatus === 'BEHIND') {
      if (sync >= options.maxSyncs) return done('timed-out', 'kept falling behind base');
      await github.updateBranch(pr.number);
      await delay(options.rerunSettleMs);
      continue;
    }

    const unresolved = await github.unresolvedThreadCount(pr.number);
    const decision = mergeDecision({
      mergeable: state.mergeable,
      checks: watch.checks,
      unresolvedThreads: unresolved,
      authorized: true,
      isDraft: state.isDraft,
    });
    if (!decision.merge) return done(classifyRefusal(decision.reason), decision.reason);

    await github.squashMerge(pr.number);
    return done('merged', 'squash-merged');
  }
}

/** Group the results for a closing summary line per outcome. */
function summarise(results: readonly TrainResult[]): void {
  const byOutcome = new Map<TrainOutcome, number[]>();
  for (const r of results) {
    const list = byOutcome.get(r.outcome) ?? [];
    list.push(r.number);
    byOutcome.set(r.outcome, list);
  }
  const lines = [...byOutcome.entries()].map(
    ([outcome, numbers]) => `  ${outcome}: ${numbers.map((n) => `#${n}`).join(', ')}`
  );
  log.banner(`Merge train summary\n${lines.join('\n')}`);
}

/**
 * Run the train over every selected pull request in order. In a dry run it only
 * reports the plan; otherwise it merges what it can and skips the rest, and
 * returns a result per pull request either way.
 */
export async function runMergeTrain(github: GitHub, options: TrainOptions): Promise<TrainResult[]> {
  const all = await github.listOpenPullRequestsDetailed();
  const selected = selectTrainPRs(all, options.filter);

  log.banner(
    `Merge train${options.dryRun ? ' (dry run)' : ''}: ${selected.length} candidate PR(s)\n` +
      `  ${selected.map((p) => `#${p.number}`).join(' ') || '(none)'}`
  );

  const results: TrainResult[] = [];
  for (const pr of selected) {
    const result = options.dryRun ? await planOne(github, pr) : await mergeOne(github, pr, options);
    results.push(result);
    log.info(`#${result.number}: ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
  }

  summarise(results);
  return results;
}
