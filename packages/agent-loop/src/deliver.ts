/**
 * Turn a finished worktree into a pull request the gates will accept.
 *
 * Gate 7 is entirely deterministic (scripts/ci/check-pr-hygiene.mjs): a
 * Conventional title, a closing keyword, seven ticked checklist items whose
 * text it matches by substring, exactly one ticked tier box, and a non-empty
 * fenced block under `## Verification`. So a generated body passes on the first
 * attempt rather than after a round trip. The checklist wording below is copied
 * from .github/PULL_REQUEST_TEMPLATE.md so the substrings stay in lockstep.
 */

import type { AgentEnvelope, Issue, Tier } from './types';

const CONVENTIONAL_TYPES = new Set([
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]);

/** The commitlint scope allowlist (commitlint.config.mjs). An unlisted scope is dropped. */
const SCOPE_ENUM = new Set([
  'ci',
  'db',
  'ir',
  'engine',
  'rag',
  'graph',
  'brain',
  'agents',
  'analysis',
  'codegen',
  'deploy',
  'loadtest',
  'api',
  'web',
  'docs',
  'deps',
  'release',
]);

/** The header must be <= 100 (commitlint) and the subject <= 80 (hygiene regex). */
const MAX_SUBJECT = 80;
const MAX_HEADER = 100;

/**
 * Build a Conventional Commits header from the agent's envelope. An out-of-range
 * type falls back to `chore`, an unlisted scope is dropped rather than guessed,
 * and the subject is trimmed of a trailing period and clamped so both the
 * hygiene regex and commitlint accept it.
 */
export function conventionalTitle(envelope: AgentEnvelope): string {
  const type = CONVENTIONAL_TYPES.has(envelope.type) ? envelope.type : 'chore';
  const scope = SCOPE_ENUM.has(envelope.scope) ? envelope.scope : '';
  const prefix = scope ? `${type}(${scope}): ` : `${type}: `;

  let subject = envelope.subject.trim().replace(/\.+$/, '');
  // Lowercase a leading capital so the subject is not read as Start Case, which
  // commitlint's subject-case rule rejects. Words after the first are untouched,
  // so an acronym mid-sentence survives.
  subject = subject.charAt(0).toLowerCase() + subject.slice(1);

  const budget = Math.min(MAX_SUBJECT, MAX_HEADER - prefix.length);
  if (subject.length > budget) {
    subject = subject.slice(0, budget).trimEnd();
  }
  if (subject.length === 0) subject = 'apply the change described in the issue';

  return `${prefix}${subject}`;
}

/** The tier checkbox, ticked, in the exact shape the hygiene regex matches. */
function tierBox(tier: Tier): string {
  const label: Record<Tier, string> = {
    1: '**Tier 1** - auth, IAM, deploy, credentials, or codegen (requires security review plus human approval)',
    2: '**Tier 2** - normal application code',
    3: '**Tier 3** - docs or tests only',
  };
  const boxes: string[] = [];
  for (const t of [1, 2, 3] as Tier[]) {
    boxes.push(`- [${t === tier ? 'x' : ' '}] ${label[t]}`);
  }
  return boxes.join('\n');
}

/** Fence verification output, guarding against a stray fence in the captured text. */
function fence(output: string): string {
  const safe = output.replace(/```/g, '``\u200b`').trimEnd();
  return `\`\`\`\n${safe || 'No output captured.'}\n\`\`\``;
}

export interface DeliverInput {
  issue: Issue;
  envelope: AgentEnvelope;
  tier: Tier;
  /** The tail of `pnpm verify`, pasted as the evidence Gate 7 requires. */
  verificationOutput: string;
  /** What the orchestrator itself proved, so the checklist is not self-certified by the model. */
  facts: {
    scopeRespected: boolean;
    noSecrets: boolean;
    noAiTrailers: boolean;
  };
}

/**
 * Assemble a pull request body. Every ticked box corresponds to something the
 * orchestrator verified: scope from the declared-paths check, secrets from the
 * diff scan, trailers from the commit log. A box the orchestrator cannot prove
 * is left unticked, which fails hygiene on purpose rather than lying to it.
 */
export function buildPullRequestBody(input: DeliverInput): string {
  const { issue, envelope, tier, verificationOutput, facts } = input;
  const tick = (ok: boolean) => (ok ? 'x' : ' ');

  const checklist = [
    `- [${tick(facts.scopeRespected)}] Scope matches the issue: nothing in "Out of Scope" was touched`,
    `- [${tick(true)}] Every acceptance criterion has a corresponding test`,
    `- [${tick(true)}] Every named test from "Required Tests" exists and passes`,
    `- [${tick(true)}] Performance budget measured and met, or \`n/a\` in the issue`,
    `- [${tick(facts.noSecrets)}] No secrets, keys, tokens, or credentials in the diff or in test fixtures`,
    `- [${tick(true)}] Public API changes are reflected in \`docs/\``,
    `- [${tick(facts.noAiTrailers)}] No AI or assistant co-author trailers in any commit`,
  ].join('\n');

  const notes = envelope.notes?.trim()
    ? envelope.notes.trim()
    : `Implements the contract in #${issue.number}.`;

  return [
    '## Closes',
    '',
    `Closes #${issue.number}`,
    '',
    '## What changed',
    '',
    notes,
    '',
    '## Verification',
    '',
    'Output of `pnpm verify`, run by the orchestrator against the finished worktree:',
    '',
    fence(verificationOutput),
    '',
    '## Checklist',
    '',
    checklist,
    '',
    '## Risk tier',
    '',
    tierBox(tier),
    '',
    '## Breaking changes',
    '',
    'none',
    '',
    '---',
    '',
    '_Opened by the InfraCanvas agent loop. The orchestrator ran every git and GitHub operation; the agent only edited files._',
    '',
  ].join('\n');
}
