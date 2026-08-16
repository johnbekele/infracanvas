/**
 * What the agent is told. The issue body is the contract and is pasted verbatim
 * — paraphrasing it is how two agents end up building two different interfaces.
 * Everything the loop adds is a boundary: the paths this lane owns, and the
 * operations the agent must never perform because the orchestrator owns them.
 */

import type { AgentEnvelope, Issue, Lane } from './types';

/** A machine-readable envelope so the loop can build a commit title without parsing prose. */
const ENVELOPE_INSTRUCTION = `When you have finished, print a single fenced \`json\` block as your final message, and nothing after it:

\`\`\`json
{
  "type": "feat|fix|docs|style|refactor|perf|test|build|ci|chore",
  "scope": "one of: ci db ir engine rag graph brain agents analysis codegen deploy loadtest api web docs deps release",
  "subject": "imperative, lower case, no trailing period, under 70 characters",
  "notes": "two or three sentences a reviewer needs, describing behaviour not file names",
  "blocked": null
}
\`\`\`

If you could not complete the work, set \`blocked\` to a short sentence saying why, and leave the rest as your best effort.`;

/** The operations the orchestrator reserves. An agent that runs these corrupts the loop's own bookkeeping. */
function prohibitions(boundaryPaths: readonly string[]): string {
  const paths =
    boundaryPaths.length > 0
      ? boundaryPaths.map((p) => `  - ${p}`).join('\n')
      : '  (see the Files section of the issue)';
  return `Hard rules:
- Do not run git. Do not commit, push, branch, or rebase. The orchestrator does all of that.
- Do not open, edit, review, or merge a pull request, and do not touch the gh CLI.
- Edit only files inside this worktree, and only the paths this issue's Files section declares:
${paths}
  If finishing the work needs a path this list does not name, stop and report it in the \`blocked\` field rather than editing outside the list.
- Adding a dependency is in scope by default: you may edit the manifest and lockfile it needs — package.json and pnpm-lock.yaml, or Cargo.toml/Cargo.lock or pyproject.toml/uv.lock for the language you are working in — even when the Files section omits them. Make the smallest change that adds what you need, and never bump unrelated packages.
- Do not touch \`.github/\`, the gates, or the CI configuration unless the issue's Files section names them.
- Do not add an AI or assistant co-author trailer anywhere.
- Follow AGENTS.md. Write the tests the "Required Tests" section names. Respect "Out of Scope".
- Run \`pnpm verify\` yourself and fix what it reports before you declare the work done.`;
}

export interface TaskPromptInput {
  issue: Issue;
  lane: Lane;
  /**
   * The blast radius the agent may edit: the paths the issue's `### Files`
   * section declares, which Gate 0 forces every issue to carry. The lane is
   * only which tool runs; the issue, not the lane, bounds what it may touch —
   * so an `area:api` issue in a lane whose coarse path list omits `apps/api/`
   * is still free to edit exactly the api files it declared.
   */
  boundaryPaths: readonly string[];
}

/** The prompt that starts an issue from scratch. */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const { issue, boundaryPaths } = input;
  return [
    `You are implementing a single issue in the InfraCanvas repository, working in an isolated git worktree.`,
    ``,
    `# Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body.trim(),
    ``,
    `# ${'-'.repeat(40)}`,
    ``,
    prohibitions(boundaryPaths),
    ``,
    ENVELOPE_INSTRUCTION,
  ].join('\n');
}

export interface RepairPromptInput {
  issue: Issue;
  /** `verify` for a local `pnpm verify` failure, `ci` for a red required check. */
  kind: 'verify' | 'ci';
  /** The failing output: the verify summary, or the failing job log. */
  failureOutput: string;
}

/** The prompt that feeds a failure back for another pass. */
export function buildRepairPrompt(input: RepairPromptInput): string {
  const { issue, kind, failureOutput } = input;
  const source =
    kind === 'verify'
      ? '`pnpm verify` failed locally. Its output is below.'
      : 'A required CI check failed after the pull request opened. The failing log is below.';

  return [
    `The work on issue #${issue.number} (${issue.title}) is not yet passing.`,
    ``,
    source,
    ``,
    '```',
    failureOutput.replace(/```/g, '``\u200b`').trim().slice(0, 12000),
    '```',
    ``,
    `Fix the cause, not the symptom. Do not weaken a test or a gate to make it pass. Change only files this issue owns.`,
    `When it passes, print the same JSON envelope as before as your final message.`,
  ].join('\n');
}

/** True when the agent reported it could not finish. */
export function isBlocked(envelope: AgentEnvelope): boolean {
  return typeof envelope.blocked === 'string' && envelope.blocked.trim().length > 0;
}
