import { describe, expect, it } from 'vitest';

import { selectTrainPRs, type TrainCandidate } from './merge-train';

function pr(overrides: Partial<TrainCandidate> = {}): TrainCandidate {
  return {
    number: 1,
    title: 'a change',
    baseRefName: 'main',
    isDraft: false,
    labels: [],
    ...overrides,
  };
}

const filter = {
  baseBranch: 'main',
  includeTier1: false,
  includeDeps: false,
  includeAgentLoop: false,
} as const;

describe('selectTrainPRs', () => {
  it('keeps a plain pull request that targets the base branch', () => {
    expect(selectTrainPRs([pr({ number: 5 })], filter).map((p) => p.number)).toEqual([5]);
  });

  it('returns candidates in ascending number order', () => {
    const prs = [pr({ number: 9 }), pr({ number: 2 }), pr({ number: 7 })];
    expect(selectTrainPRs(prs, filter).map((p) => p.number)).toEqual([2, 7, 9]);
  });

  it('excludes a pull request that targets a different base', () => {
    expect(selectTrainPRs([pr({ number: 3, baseRefName: 'feat/x' })], filter)).toEqual([]);
  });

  it('excludes a draft', () => {
    expect(selectTrainPRs([pr({ number: 3, isDraft: true })], filter)).toEqual([]);
  });

  it('excludes tier:1 and needs:security-review by default', () => {
    const prs = [
      pr({ number: 1, labels: ['tier:1'] }),
      pr({ number: 2, labels: ['needs:security-review'] }),
      pr({ number: 3, labels: ['tier:2'] }),
    ];
    expect(selectTrainPRs(prs, filter).map((p) => p.number)).toEqual([3]);
  });

  it('includes tier:1 when asked', () => {
    const prs = [pr({ number: 1, labels: ['tier:1'] })];
    expect(selectTrainPRs(prs, { ...filter, includeTier1: true }).map((p) => p.number)).toEqual([
      1,
    ]);
  });

  it('excludes dependabot by default and includes it when asked', () => {
    const prs = [pr({ number: 1, labels: ['dependencies'] })];
    expect(selectTrainPRs(prs, filter)).toEqual([]);
    expect(selectTrainPRs(prs, { ...filter, includeDeps: true }).map((p) => p.number)).toEqual([1]);
  });

  it('excludes agent-loop PRs by default so it does not race the running loop', () => {
    const prs = [pr({ number: 1, labels: ['agent-loop'] })];
    expect(selectTrainPRs(prs, filter)).toEqual([]);
    expect(selectTrainPRs(prs, { ...filter, includeAgentLoop: true }).map((p) => p.number)).toEqual(
      [1]
    );
  });

  it('an explicit number list overrides the label and base filters', () => {
    const prs = [
      pr({ number: 1, labels: ['tier:1'] }),
      pr({ number: 2, baseRefName: 'feat/x' }),
      pr({ number: 3, isDraft: true }),
      pr({ number: 4 }),
    ];
    expect(selectTrainPRs(prs, { ...filter, onlyNumbers: [1, 2, 3] }).map((p) => p.number)).toEqual(
      [1, 2, 3]
    );
  });
});
