/**
 * The loop's own record of what happened. Deliberately the same shape as the
 * `agent_runs` / `agent_run_events` contract in issue #198, so that when epic 18
 * lands the reporter (#201) has a real producer to forward and the lane board
 * (#200) has something to draw. Until then it is a local JSONL log plus a
 * status snapshot the operator can tail.
 *
 * Events carry a monotonic cursor rather than a timestamp as their identity,
 * because two events written in the same millisecond still need an unambiguous
 * order — the same reason #198 uses a bigserial.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { AgentId, Lane } from './types';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'abandoned';
export type EventLevel = 'info' | 'warn' | 'error';

/** Coarse phase labels, so a board can show progress without parsing prose. */
export type Phase =
  | 'claim'
  | 'worktree'
  | 'implement'
  | 'verify'
  | 'repair'
  | 'deliver'
  | 'watch-ci'
  | 'merge'
  | 'cleanup'
  | 'blocked';

const AGENT_KIND: Record<AgentId, string> = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
};

export interface RunEvent {
  cursor: number;
  at: string;
  level: EventLevel;
  phase: Phase;
  message: string;
  progress?: number;
}

export interface RunSnapshot {
  issue: number;
  agent: string;
  lane: Lane;
  branch: string;
  worktreePath: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  lastCursor: number;
  prNumber: number | null;
}

/** One run's append-only event log and its current snapshot. */
export class RunReporter {
  private cursor = 0;
  private readonly eventsFile: string;
  private readonly snapshotFile: string;
  private snapshot: RunSnapshot;

  constructor(
    runsDir: string,
    init: { issue: number; agent: AgentId; lane: Lane; branch: string; worktreePath: string }
  ) {
    mkdirSync(runsDir, { recursive: true });
    this.eventsFile = join(runsDir, `${init.issue}.jsonl`);
    this.snapshotFile = join(runsDir, `${init.issue}.status.json`);
    this.snapshot = {
      issue: init.issue,
      agent: AGENT_KIND[init.agent],
      lane: init.lane,
      branch: init.branch,
      worktreePath: init.worktreePath,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastCursor: 0,
      prNumber: null,
    };
    this.persistSnapshot();
  }

  private persistSnapshot(): void {
    writeFileSync(this.snapshotFile, JSON.stringify(this.snapshot, null, 2));
  }

  /** Append an event and advance the cursor. */
  event(level: EventLevel, phase: Phase, message: string, progress?: number): void {
    this.cursor += 1;
    const event: RunEvent = {
      cursor: this.cursor,
      at: new Date().toISOString(),
      level,
      phase,
      message: message.slice(0, 8192),
      ...(progress !== undefined ? { progress } : {}),
    };
    appendFileSync(this.eventsFile, `${JSON.stringify(event)}\n`);
    this.snapshot.lastCursor = this.cursor;
    this.persistSnapshot();
  }

  setPr(prNumber: number): void {
    this.snapshot.prNumber = prNumber;
    this.persistSnapshot();
  }

  /** Record a terminal status. `abandoned` is for a run that went silent or timed out. */
  finish(status: Exclude<RunStatus, 'running'>): void {
    this.snapshot.status = status;
    this.snapshot.endedAt = new Date().toISOString();
    this.persistSnapshot();
  }
}

/** Read every run snapshot for the board-style overview the CLI prints. */
export function readSnapshots(runsDir: string): RunSnapshot[] {
  if (!existsSync(runsDir)) return [];
  const snapshots: RunSnapshot[] = [];
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith('.status.json')) continue;
    try {
      snapshots.push(JSON.parse(readFileSync(join(runsDir, name), 'utf8')) as RunSnapshot);
    } catch {
      continue;
    }
  }
  return snapshots.sort((a, b) => a.issue - b.issue);
}
