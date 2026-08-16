import { describe, expect, it } from 'vitest';

import { mergeDecision, type MergeInput } from './merge';
import type { CheckRun } from './types';

const green: CheckRun[] = [
  { name: 'Format', state: 'pass' },
  { name: 'Unit tests (TypeScript)', state: 'pass' },
];

function input(overrides: Partial<MergeInput> = {}): MergeInput {
  return {
    mergeable: 'MERGEABLE',
    checks: green,
    unresolvedThreads: 0,
    isAgentLoop: true,
    isDraft: false,
    ...overrides,
  };
}

describe('mergeDecision', () => {
  it('merges when mergeable, green, and threads resolved', () => {
    expect(mergeDecision(input())).toEqual({
      merge: true,
      reason: 'mergeable, all required checks green, threads resolved',
    });
  });

  it('never merges a pull request the loop did not open', () => {
    expect(mergeDecision(input({ isAgentLoop: false })).merge).toBe(false);
  });

  it('never merges a draft', () => {
    expect(mergeDecision(input({ isDraft: true })).merge).toBe(false);
  });

  it('does not merge a conflicting branch', () => {
    expect(mergeDecision(input({ mergeable: 'CONFLICTING' })).reason).toMatch(/conflict/);
  });

  it('waits while mergeability is unknown', () => {
    expect(mergeDecision(input({ mergeable: 'UNKNOWN' })).reason).toMatch(/not yet computed/);
  });

  it('does not merge with an unresolved review thread', () => {
    expect(mergeDecision(input({ unresolvedThreads: 2 })).reason).toMatch(/2 unresolved/);
  });

  it('does not merge with a failing check, and names it', () => {
    const checks: CheckRun[] = [...green, { name: 'Diff coverage', state: 'fail' }];
    expect(mergeDecision(input({ checks })).reason).toMatch(/Diff coverage/);
  });

  it('waits while a check is still pending', () => {
    const checks: CheckRun[] = [...green, { name: 'Build', state: 'pending' }];
    expect(mergeDecision(input({ checks })).reason).toMatch(/still running/);
  });

  it('does not merge before any check has reported', () => {
    expect(mergeDecision(input({ checks: [] })).reason).toMatch(/no checks/);
  });

  it('ignores skipped checks, which do not block', () => {
    const checks: CheckRun[] = [...green, { name: 'Optional', state: 'skipping' }];
    expect(mergeDecision(input({ checks })).merge).toBe(true);
  });
});
