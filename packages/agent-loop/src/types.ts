/**
 * The vocabulary the loop reasons about. Kept in one file because every other
 * module speaks it, and a decision the merge step makes has to mean the same
 * thing the queue step meant.
 */

/** A lane is a tool, not a feature. Ownership is by path (see conflicts.ts). */
export type Lane = 'A' | 'B' | 'C';

/** Risk tier as the gates use it: 1 is credential/IAM/codegen, 3 is docs only. */
export type Tier = 1 | 2 | 3;

/** The three coding agents the loop drives, one per lane. */
export type AgentId = 'claude' | 'codex' | 'cursor';

/** An issue as the loop needs it: enough to decide, claim, and prompt. */
export interface Issue {
  number: number;
  title: string;
  /** Label names, e.g. `agent-ready`, `area:db`, `tier:2`, `status:in-progress`. */
  labels: string[];
  /** The full spec body. It is the contract; the prompt pastes it verbatim. */
  body: string;
  state: 'open' | 'closed';
}

/** One line of a spec's `### Files` section. */
export interface FileChange {
  op: 'CREATE' | 'MODIFY' | 'DELETE';
  path: string;
}

/** An open pull request, as far as the queue cares: which issues it closes. */
export interface OpenPullRequest {
  number: number;
  body: string;
  headRefName: string;
  isAgentLoop: boolean;
}

/**
 * The structured final message an agent returns, so a Conventional Commits
 * title can be built without parsing prose. `blocked` is a non-empty reason
 * when the agent could not complete the work; everything else is then ignored.
 */
export interface AgentEnvelope {
  type: 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'perf' | 'test' | 'build' | 'ci' | 'chore';
  scope: string;
  subject: string;
  notes?: string;
  blocked?: string | null;
}

/** A single required check on a pull request, normalised across gh's shapes. */
export interface CheckRun {
  name: string;
  /** `pass`, `fail`, `pending`, or `skipping` — gh's own bucket. */
  state: 'pass' | 'fail' | 'pending' | 'skipping';
}

/** What a running lane holds. Serialised into the run log and the lockfile. */
export interface Claim {
  issue: number;
  lane: Lane;
  agent: AgentId;
  branch: string;
  slug: string;
  worktree: string;
  /** Paths this issue declared it would touch, for overlap detection. */
  paths: string[];
  startedAt: string;
}
