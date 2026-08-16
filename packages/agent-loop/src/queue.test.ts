import { describe, expect, it } from 'vitest';

import {
  evaluate,
  issuesClosedByPr,
  laneForIssue,
  parseDependencies,
  selectEligible,
  type QueueContext,
} from './queue';
import type { Issue, OpenPullRequest } from './types';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: '[db] a thing',
    labels: ['agent-ready', 'area:db', 'tier:2'],
    body: '### Dependencies\n\nnone\n\n### Files\n\n- CREATE `db/x.sql`\n',
    state: 'open',
    ...overrides,
  };
}

const emptyCtx: QueueContext = {
  closedIssues: new Set(),
  claimedIssues: new Set(),
  openPullRequests: [],
  runningPaths: [],
};

describe('laneForIssue', () => {
  it('maps db and ir to lane A', () => {
    expect(laneForIssue(issue({ labels: ['area:db'] }))).toBe('A');
    expect(laneForIssue(issue({ labels: ['area:ir'] }))).toBe('A');
  });

  it('maps ci and infra to lane B', () => {
    expect(laneForIssue(issue({ labels: ['area:ci'] }))).toBe('B');
    expect(laneForIssue(issue({ labels: ['area:infra'] }))).toBe('B');
  });

  it('maps web, api, rust and brain to lane C', () => {
    for (const area of ['area:web', 'area:api', 'area:rust', 'area:brain']) {
      expect(laneForIssue(issue({ labels: [area] }))).toBe('C');
    }
  });

  it('resolves a multi-lane issue by precedence, so the gate lane leads', () => {
    expect(laneForIssue(issue({ labels: ['area:api', 'area:ci'] }))).toBe('B');
    expect(laneForIssue(issue({ labels: ['area:api', 'area:db'] }))).toBe('A');
  });

  it('is null when no area label maps to a lane', () => {
    expect(laneForIssue(issue({ labels: ['agent-ready'] }))).toBeNull();
  });
});

describe('parseDependencies', () => {
  it('reads issue numbers from the Dependencies section', () => {
    const body = '### Dependencies\n\n- #198 — the model\n- #199 — the token\n\n### Verification\n';
    expect(parseDependencies(body).sort()).toEqual([198, 199]);
  });

  it('returns an empty list for `none`', () => {
    expect(parseDependencies('### Dependencies\n\nnone\n')).toEqual([]);
  });

  it('ignores issue references outside the Dependencies section', () => {
    const body = '### Context\n\nsee #500\n\n### Dependencies\n\n#42\n\n### Files\n\nsee #999\n';
    expect(parseDependencies(body)).toEqual([42]);
  });
});

describe('issuesClosedByPr', () => {
  it('extracts every closing keyword and number', () => {
    const pr: OpenPullRequest = {
      number: 176,
      body: 'Closes #189\nfixes #191 and resolves #192',
      headRefName: 'x',
      isAgentLoop: false,
    };
    expect(issuesClosedByPr(pr).sort((a, b) => a - b)).toEqual([189, 191, 192]);
  });

  it('ignores a bare mention that is not a closing keyword', () => {
    const pr: OpenPullRequest = {
      number: 1,
      body: 'see #5 for context',
      headRefName: 'x',
      isAgentLoop: false,
    };
    expect(issuesClosedByPr(pr)).toEqual([]);
  });
});

describe('evaluate', () => {
  it('accepts an agent-ready, unblocked, unclaimed issue', () => {
    expect(evaluate(issue(), emptyCtx)).toEqual({ eligible: true });
  });

  it('rejects an issue that is not agent-ready', () => {
    expect(evaluate(issue({ labels: ['area:db'] }), emptyCtx).eligible).toBe(false);
  });

  it('rejects an issue already in progress or blocked', () => {
    expect(
      evaluate(issue({ labels: ['agent-ready', 'area:db', 'status:in-progress'] }), emptyCtx).reason
    ).toMatch(/in progress/);
    expect(
      evaluate(issue({ labels: ['agent-ready', 'area:db', 'status:blocked'] }), emptyCtx).reason
    ).toMatch(/blocked/);
  });

  it('rejects an issue whose dependency is still open', () => {
    const dependent = issue({ body: '### Dependencies\n\n- #198 — first\n' });
    expect(evaluate(dependent, emptyCtx).reason).toMatch(/#198/);
    const withClosed = { ...emptyCtx, closedIssues: new Set([198]) };
    expect(evaluate(dependent, withClosed).eligible).toBe(true);
  });

  it('rejects an issue a local lane already claimed', () => {
    const ctx = { ...emptyCtx, claimedIssues: new Set([1]) };
    expect(evaluate(issue(), ctx).reason).toMatch(/already claimed/);
  });

  it('rejects an issue an open pull request already closes — the PR #176 collision', () => {
    const ctx: QueueContext = {
      ...emptyCtx,
      openPullRequests: [
        { number: 176, body: 'Closes #1', headRefName: 'docs/redesign', isAgentLoop: false },
      ],
    };
    expect(evaluate(issue({ number: 1 }), ctx).reason).toMatch(/#176 already closes it/);
  });

  it('rejects an issue whose declared paths overlap a running issue', () => {
    const ctx = { ...emptyCtx, runningPaths: ['db/'] };
    expect(evaluate(issue(), ctx).reason).toMatch(/overlap/);
  });
});

describe('selectEligible', () => {
  it('returns eligible issues lowest number first', () => {
    const issues = [
      issue({ number: 5 }),
      issue({ number: 2 }),
      issue({ number: 9, labels: ['area:db'] }), // not agent-ready
    ];
    expect(selectEligible(issues, emptyCtx).map((i) => i.number)).toEqual([2, 5]);
  });
});
