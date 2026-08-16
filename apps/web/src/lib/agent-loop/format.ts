// Presentation helpers for the agent-loop board. Pure, so the board components
// stay declarative and the formatting is tested without a DOM.
import type { Lane, RunStatus } from '../api/agent-loop';

const LANE_AGENT: Record<Lane, string> = {
  A: 'Claude Code',
  B: 'Codex',
  C: 'Cursor',
};

/** The human agent name for a lane, for the lane summary strip. */
export function laneAgent(lane: Lane): string {
  return LANE_AGENT[lane];
}

/** The agent kind the loop records ("claude-code") as a display name. */
export function agentName(agent: string): string {
  switch (agent) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    default:
      return agent;
  }
}

const STATUS_TONE: Record<RunStatus, string> = {
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  succeeded: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  abandoned: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
};

/** Tailwind classes for a status pill, so a glance reads success from failure. */
export function statusTone(status: RunStatus): string {
  return STATUS_TONE[status];
}

/** A phase word ("verify") as a capitalised label. */
export function phaseLabel(phase: string | null): string {
  if (!phase) return '—';
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/**
 * A coarse "3m ago" from an ISO time. Coarse on purpose: the board updates
 * continuously, so seconds-level precision would just flicker.
 */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Elapsed wall time of a run, from its start to its end or now. */
export function duration(
  startedAt: string,
  endedAt: string | null,
  now: number = Date.now()
): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '';
  const end = endedAt ? Date.parse(endedAt) : now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}
