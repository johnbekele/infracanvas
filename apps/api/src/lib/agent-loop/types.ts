/**
 * The shapes the agent-loop dashboard serves to the browser.
 *
 * These deliberately mirror the loop's own `RunSnapshot`/`RunEvent`
 * (packages/agent-loop/src/report.ts) and the `agent_runs`/`agent_run_events`
 * contract in epic 18. The API re-declares them rather than importing the loop
 * package, so the read model is decoupled from the producer: today it is filled
 * from the loop's local files, and when epic 18 lands it can be filled from the
 * database without the browser contract changing.
 */

export type Lane = 'A' | 'B' | 'C';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'abandoned';
export type EventLevel = 'info' | 'warn' | 'error';

export interface LoopEvent {
  cursor: number;
  at: string;
  level: EventLevel;
  phase: string;
  message: string;
  progress?: number;
}

/** One agent's run, enriched with the latest activity from its event log. */
export interface LoopRun {
  issue: number;
  agent: string;
  lane: Lane;
  branch: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  prNumber: number | null;
  lastCursor: number;
  /** The phase of the most recent event, so a card can show what it is doing now. */
  phase: string | null;
  lastMessage: string | null;
  lastEventAt: string | null;
}

/** Whether the loop process is alive and what it is holding, for the header and controls. */
export interface LoopStatus {
  running: boolean;
  pid: number | null;
  /** The kill switch is present, so the loop will stop at the next transition. */
  stopRequested: boolean;
  /** Issue numbers with an active claim lockfile. */
  claims: number[];
  stateDir: string;
}

/** The whole board in one payload: the header status and every run, newest activity first. */
export interface LoopBoard {
  status: LoopStatus;
  runs: LoopRun[];
}

/**
 * The read side of the dashboard. A file-backed implementation serves the local
 * loop today; a database-backed one can serve epic 18 later behind the same
 * interface, which is why the routes depend on this and not on the filesystem.
 */
export interface LoopStateSource {
  board(): LoopBoard;
  events(issue: number, afterCursor?: number): LoopEvent[];
}
