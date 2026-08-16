import { describe, expect, it } from 'vitest';

import { buildPullRequestBody, conventionalTitle, type DeliverInput } from './deliver';
import type { AgentEnvelope, Issue } from './types';

// The exact expressions Gate 7 (scripts/ci/check-pr-hygiene.mjs) applies, copied
// so a change to the generator that would fail hygiene fails a test first.
const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .{1,80}$/;
const REQUIRED_CHECKLIST = [
  'Scope matches the issue',
  'Every acceptance criterion has a corresponding test',
  'Every named test',
  'Performance budget measured',
  'No secrets, keys, tokens',
  'Public API changes are reflected',
  'No AI or assistant co-author trailers',
];

function envelope(overrides: Partial<AgentEnvelope> = {}): AgentEnvelope {
  return {
    type: 'feat',
    scope: 'db',
    subject: 'add the workspaces table',
    blocked: null,
    ...overrides,
  };
}

describe('conventionalTitle', () => {
  it('builds a header the hygiene regex accepts', () => {
    expect(conventionalTitle(envelope())).toBe('feat(db): add the workspaces table');
    expect(CONVENTIONAL.test(conventionalTitle(envelope()))).toBe(true);
  });

  it('drops a scope not in the commitlint allowlist rather than emitting an invalid one', () => {
    expect(conventionalTitle(envelope({ scope: 'not-a-scope' }))).toBe(
      'feat: add the workspaces table'
    );
  });

  it('falls back to chore for an unknown type', () => {
    // A cast is only to exercise the runtime guard against a bad envelope.
    const bad = { ...envelope(), type: 'nonsense' } as unknown as AgentEnvelope;
    expect(conventionalTitle(bad).startsWith('chore')).toBe(true);
  });

  it('lowercases a leading capital so subject-case does not reject it', () => {
    expect(conventionalTitle(envelope({ subject: 'Add the table' }))).toBe(
      'feat(db): add the table'
    );
  });

  it('clamps a long subject so the header stays within budget', () => {
    const title = conventionalTitle(envelope({ subject: 'x'.repeat(200) }));
    expect(title.length).toBeLessThanOrEqual(100);
    expect(CONVENTIONAL.test(title)).toBe(true);
  });

  it('strips a trailing period', () => {
    expect(conventionalTitle(envelope({ subject: 'add it.' }))).toBe('feat(db): add it');
  });
});

function issue(): Issue {
  return { number: 42, title: '[db] a thing', labels: ['tier:2'], body: '', state: 'open' };
}

function deliverInput(overrides: Partial<DeliverInput> = {}): DeliverInput {
  return {
    issue: issue(),
    envelope: envelope(),
    tier: 2,
    verificationOutput: '64 passed, 0 failed, 3 skipped.',
    facts: { scopeRespected: true, noSecrets: true, noAiTrailers: true },
    ...overrides,
  };
}

describe('buildPullRequestBody', () => {
  it('closes the issue with a keyword Gate 7 recognises', () => {
    const body = buildPullRequestBody(deliverInput());
    expect(/\b(closes|fixes|resolves)\s+#\d+/i.test(body)).toBe(true);
    expect(body).toContain('Closes #42');
  });

  it('includes every required checklist item, ticked, when the facts hold', () => {
    const body = buildPullRequestBody(deliverInput());
    for (const item of REQUIRED_CHECKLIST) {
      const line = body.split('\n').find((l) => l.includes(item) && /^\s*-\s*\[[ x]\]/i.test(l));
      expect(line, `checklist item present: ${item}`).toBeDefined();
      expect(/^\s*-\s*\[x\]/i.test(line as string), `checklist item ticked: ${item}`).toBe(true);
    }
  });

  it('leaves the scope box unticked when the agent strayed outside its paths', () => {
    const body = buildPullRequestBody(
      deliverInput({ facts: { scopeRespected: false, noSecrets: true, noAiTrailers: true } })
    );
    const line = body.split('\n').find((l) => l.includes('Scope matches the issue'));
    expect(/^\s*-\s*\[ \]/.test(line as string)).toBe(true);
  });

  it('ticks exactly one risk tier, in the shape the hygiene regex matches', () => {
    const body = buildPullRequestBody(deliverInput({ tier: 1 }));
    const ticked = body.match(/^\s*-\s*\[x\]\s*\*\*Tier [123]\*\*/gim) ?? [];
    expect(ticked).toHaveLength(1);
    expect(ticked[0]).toMatch(/Tier 1/);
  });

  it('puts a non-empty fenced block under the Verification heading', () => {
    const body = buildPullRequestBody(deliverInput());
    const verification = /## Verification\s*\n+([\s\S]*?)(?:\n## |$)/.exec(body)?.[1] ?? '';
    const fenced = /```[\s\S]*?```/.exec(verification)?.[0] ?? '';
    expect(fenced.replace(/```/g, '').trim().length).toBeGreaterThan(0);
  });

  it('neutralises a stray fence in the captured verification output', () => {
    const body = buildPullRequestBody(deliverInput({ verificationOutput: 'before ``` after' }));
    // The only real fences are the ones the generator added, so the block is balanced.
    const fences = body.match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});
