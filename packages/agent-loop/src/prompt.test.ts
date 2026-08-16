import { describe, expect, it } from 'vitest';

import { buildRepairPrompt, buildTaskPrompt, isBlocked } from './prompt';
import type { AgentEnvelope, Issue } from './types';

function issue(): Issue {
  return {
    number: 190,
    title: '[db] organizations and workspaces',
    labels: ['agent-ready', 'area:db', 'tier:2'],
    body: '### Contract\n\nDDL here.\n\n### Files\n\n- CREATE `db/x.sql`\n',
    state: 'open',
  };
}

describe('buildTaskPrompt', () => {
  it('pastes the issue body verbatim, since it is the contract', () => {
    const prompt = buildTaskPrompt({ issue: issue(), lane: 'A', boundaryPaths: ['db/'] });
    expect(prompt).toContain('### Contract');
    expect(prompt).toContain('DDL here.');
    expect(prompt).toContain('#190');
  });

  it('forbids git, gh, and merging, so only the orchestrator touches them', () => {
    const prompt = buildTaskPrompt({ issue: issue(), lane: 'A', boundaryPaths: ['db/'] });
    expect(prompt).toMatch(/Do not run git/);
    expect(prompt).toMatch(/Do not open, edit, review, or merge a pull request/);
  });

  it('bounds the agent by the paths the issue declares, not the lane', () => {
    const prompt = buildTaskPrompt({
      issue: issue(),
      lane: 'A',
      boundaryPaths: ['apps/api/src/routes/telemetry.ts', 'db/x.sql'],
    });
    expect(prompt).toContain('apps/api/src/routes/telemetry.ts');
    expect(prompt).toContain('db/x.sql');
    expect(prompt).toMatch(/Files section declares/);
  });

  it('asks for the JSON envelope as the final message', () => {
    const prompt = buildTaskPrompt({ issue: issue(), lane: 'A', boundaryPaths: [] });
    expect(prompt).toContain('```json');
    expect(prompt).toMatch(/"blocked"/);
  });
});

describe('buildRepairPrompt', () => {
  it('frames a local verify failure with its output', () => {
    const prompt = buildRepairPrompt({
      issue: issue(),
      kind: 'verify',
      failureOutput: 'ESLint: 3 problems',
    });
    expect(prompt).toMatch(/pnpm verify` failed locally/);
    expect(prompt).toContain('ESLint: 3 problems');
  });

  it('frames a CI failure differently', () => {
    const prompt = buildRepairPrompt({
      issue: issue(),
      kind: 'ci',
      failureOutput: 'Diff coverage 71%',
    });
    expect(prompt).toMatch(/required CI check failed/);
    expect(prompt).toContain('Diff coverage 71%');
  });

  it('forbids weakening a test or a gate to pass', () => {
    const prompt = buildRepairPrompt({ issue: issue(), kind: 'verify', failureOutput: 'x' });
    expect(prompt).toMatch(/Do not weaken a test or a gate/);
  });

  it('truncates a huge failure log so the prompt stays bounded', () => {
    const prompt = buildRepairPrompt({
      issue: issue(),
      kind: 'ci',
      failureOutput: 'y'.repeat(50_000),
    });
    expect(prompt.length).toBeLessThan(13_000);
  });
});

describe('isBlocked', () => {
  const base: AgentEnvelope = { type: 'feat', scope: 'db', subject: 's', blocked: null };

  it('is true only when blocked carries a non-empty reason', () => {
    expect(isBlocked({ ...base, blocked: 'needs a migration that is out of scope' })).toBe(true);
    expect(isBlocked({ ...base, blocked: null })).toBe(false);
    expect(isBlocked({ ...base, blocked: '   ' })).toBe(false);
  });
});
