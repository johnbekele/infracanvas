/**
 * What is safe to start, and who should start it.
 *
 * Every rule here is computed from live state rather than assumed from a table.
 * A hand-maintained lane assignment goes stale the moment the backlog moves,
 * and earlier in this project a stale assignment dispatched an agent onto three
 * issues that an open pull request had already implemented — a guaranteed
 * conflict. The fourth rule below exists precisely to make that impossible.
 */

import { declaredPaths, overlaps } from './conflicts';
import type { Issue, Lane, OpenPullRequest } from './types';

/** Area label -> lane. A lane is a tool; the label decides which tool, not whether it is safe. */
const LANE_BY_AREA: Record<string, Lane> = {
  'area:db': 'A',
  'area:ir': 'A',
  'area:ci': 'B',
  'area:infra': 'B',
  'area:web': 'C',
  'area:api': 'C',
  'area:rust': 'C',
  'area:brain': 'C',
};

/** Precedence when an issue carries more than one area label. */
const LANE_PRECEDENCE: Lane[] = ['B', 'A', 'C'];

/**
 * Pick the lane for an issue from its area labels. When an issue spans lanes
 * (e.g. `area:api,area:db`), the higher-precedence lane takes it, so the tool
 * that owns the more sensitive surface leads and the others stay clear.
 */
export function laneForIssue(issue: Issue): Lane | null {
  const lanes = new Set<Lane>();
  for (const label of issue.labels) {
    const lane = LANE_BY_AREA[label];
    if (lane) lanes.add(lane);
  }
  if (lanes.size === 0) return null;
  for (const lane of LANE_PRECEDENCE) {
    if (lanes.has(lane)) return lane;
  }
  return null;
}

/** Parse `### Dependencies` into issue numbers. `none` yields an empty list. */
export function parseDependencies(body: string): number[] {
  const lines = body.split('\n');
  const deps = new Set<number>();
  let inSection = false;

  for (const line of lines) {
    if (/^###\s+Dependencies\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^###\s+/.test(line)) break;
    if (!inSection) continue;
    if (/^\s*none\s*$/i.test(line)) return [];
    for (const match of line.matchAll(/#(\d+)/g)) {
      deps.add(Number.parseInt(match[1], 10));
    }
  }

  return [...deps];
}

/** Which open issues does a pull request declare it closes? */
export function issuesClosedByPr(pr: OpenPullRequest): number[] {
  const closed = new Set<number>();
  for (const match of pr.body.matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)/gi)) {
    closed.add(Number.parseInt(match[1], 10));
  }
  return [...closed];
}

/** The state the eligibility decision reads. All of it is fetched live. */
export interface QueueContext {
  /** Issue numbers known to be closed, for the dependency check. */
  closedIssues: ReadonlySet<number>;
  /** Issue numbers a local lane is already working. */
  claimedIssues: ReadonlySet<number>;
  /** Open pull requests, so an issue an open PR already closes is skipped. */
  openPullRequests: readonly OpenPullRequest[];
  /** Declared paths of every currently running issue, for overlap detection. */
  runningPaths: readonly string[];
}

export interface Eligibility {
  eligible: boolean;
  /** Present when not eligible; a short reason for the run log. */
  reason?: string;
}

/**
 * The five rules, in the order cheapest-to-check first. The first failure wins,
 * so the reason names the earliest thing that disqualified the issue.
 */
export function evaluate(issue: Issue, ctx: QueueContext): Eligibility {
  if (issue.state !== 'open') return { eligible: false, reason: 'issue is closed' };

  if (!issue.labels.includes('agent-ready')) {
    return { eligible: false, reason: 'not labelled agent-ready' };
  }
  if (issue.labels.includes('status:in-progress')) {
    return { eligible: false, reason: 'already in progress' };
  }
  if (issue.labels.includes('status:blocked')) {
    return { eligible: false, reason: 'labelled status:blocked' };
  }

  if (laneForIssue(issue) === null) {
    return { eligible: false, reason: 'no area label maps it to a lane' };
  }

  const openDeps = parseDependencies(issue.body).filter((n) => !ctx.closedIssues.has(n));
  if (openDeps.length > 0) {
    return {
      eligible: false,
      reason: `blocked on open dependencies ${openDeps.map((n) => `#${n}`).join(', ')}`,
    };
  }

  if (ctx.claimedIssues.has(issue.number)) {
    return { eligible: false, reason: 'already claimed by a running lane' };
  }

  for (const pr of ctx.openPullRequests) {
    if (issuesClosedByPr(pr).includes(issue.number)) {
      return { eligible: false, reason: `open PR #${pr.number} already closes it` };
    }
  }

  if (overlaps(declaredPaths(issue.body), [...ctx.runningPaths])) {
    return { eligible: false, reason: 'declared paths overlap a running issue' };
  }

  return { eligible: true };
}

/**
 * The eligible issues, lowest number first, so the backlog is worked in the
 * order it was written. The caller then bins them by lane.
 */
export function selectEligible(issues: readonly Issue[], ctx: QueueContext): Issue[] {
  return issues
    .filter((issue) => evaluate(issue, ctx).eligible)
    .sort((a, b) => a.number - b.number);
}
