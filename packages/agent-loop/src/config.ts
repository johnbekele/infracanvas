/**
 * Everything the loop's behaviour depends on, in one place, with defaults that
 * are safe for an unattended run. The budgets exist because an agent that never
 * finishes is worse than one that fails: a stuck lane holds a claim and starves
 * the queue, so every phase has a deadline after which the loop moves on.
 */

import { join } from 'node:path';

import type { AgentId, Lane } from './types';

export interface LoopConfig {
  repo: string;
  /** The only GitHub identity permitted here; used for issue assignment. */
  assignee: string;
  /** Where claims, run logs and the kill switch live. */
  stateDir: string;
  /** The file whose presence stops the loop between transitions. */
  killSwitch: string;
  /** Which agent drives each lane. */
  laneAgents: Record<Lane, AgentId>;
  /** Merge policy. Per the operator's choice, all tiers merge unattended. */
  mergeAllTiers: boolean;
  budgets: {
    /** Wall-clock ceiling for a single agent pass, in ms. */
    agentMs: number;
    /** Ceiling for one `pnpm verify` run, in ms. */
    verifyMs: number;
    /** How long to wait for CI to settle after opening a PR, in ms. */
    ciMs: number;
    /** Local `pnpm verify` repair attempts before blocking the issue. */
    localRepairs: number;
    /** CI repair attempts before blocking the issue. */
    ciRepairs: number;
    /** Concurrent issues across all lanes. */
    concurrency: number;
    /** Consecutive failures that pause a lane. */
    laneFailurePause: number;
  };
  /** Run the integration suites in verify. Needs Postgres and DATABASE_URL. */
  integration: boolean;
}

const MINUTE = 60 * 1000;

export function defaultConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  const stateDir = overrides.stateDir ?? join(process.cwd(), '.agent-loop');
  return {
    repo: 'johnbekele/infracanvas',
    assignee: 'johnbekele',
    stateDir,
    killSwitch: join(stateDir, 'stop'),
    laneAgents: { A: 'claude', B: 'codex', C: 'cursor' },
    mergeAllTiers: true,
    budgets: {
      agentMs: 45 * MINUTE,
      verifyMs: 20 * MINUTE,
      ciMs: 30 * MINUTE,
      localRepairs: 3,
      ciRepairs: 2,
      concurrency: 3,
      laneFailurePause: 2,
    },
    integration: Boolean(process.env.DATABASE_URL),
    ...overrides,
    // Keep the derived kill-switch path consistent when only stateDir was overridden.
    ...(overrides.stateDir && !overrides.killSwitch
      ? { killSwitch: join(overrides.stateDir, 'stop') }
      : {}),
  };
}

/** Owned path prefixes per lane, echoed into the prompt so an agent stays in its lane. */
export const LANE_PATHS: Record<Lane, string[]> = {
  A: ['db/', 'apps/api/src/lib/db/', 'packages/ir-schema/'],
  B: ['.github/', 'scripts/ci/', 'scripts/gh/'],
  C: ['apps/web/', 'packages/core/', 'crates/', 'services/brain/'],
};
