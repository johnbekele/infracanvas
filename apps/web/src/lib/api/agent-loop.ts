// The agent-loop dashboard: the live board of what each coding agent is doing,
// and the controls to start, stop, or release a run. Mirrors the API's
// apps/api/src/lib/agent-loop/types.ts. The endpoint is gated server-side and
// returns 404 when the loop dashboard is not enabled.
import { apiFetch, apiUrl } from './client';

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
  phase: string | null;
  lastMessage: string | null;
  lastEventAt: string | null;
}

export interface LoopStatus {
  running: boolean;
  pid: number | null;
  stopRequested: boolean;
  claims: number[];
  stateDir: string;
}

export interface LoopBoard {
  status: LoopStatus;
  runs: LoopRun[];
}

export const agentLoopApi = {
  async getBoard(): Promise<LoopBoard> {
    return apiFetch<LoopBoard>('/agent-loop/board');
  },

  async getEvents(issue: number, after = 0): Promise<LoopEvent[]> {
    const { events } = await apiFetch<{ events: LoopEvent[] }>(
      `/agent-loop/runs/${issue}/events?after=${after}`
    );
    return events;
  },

  async start(): Promise<{ pid: number }> {
    return apiFetch('/agent-loop/start', { method: 'POST' });
  },

  async stop(force = false): Promise<{ ok: boolean; force: boolean }> {
    return apiFetch('/agent-loop/stop', {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  },

  async release(issue: number): Promise<{ released: boolean }> {
    return apiFetch(`/agent-loop/runs/${issue}/release`, { method: 'POST' });
  },

  /** The SSE endpoint for the live board. `EventSource` needs an absolute URL. */
  streamUrl(): string {
    return apiUrl('/agent-loop/stream');
  },
};
