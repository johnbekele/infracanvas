/**
 * Turning progress frames into what the page shows.
 *
 * Separate from the hook that receives them so the rules -- a log line must not
 * drag the bar backwards, a finished run reads 100% -- can be checked without a
 * DOM or a fake EventSource. The hook is then only the subscription.
 */
import type { AnalysisStatus } from '../api/repositories';

export type ProgressLevel = 'info' | 'warn' | 'error';

export interface AnalysisProgress {
  /** 0 to 1, from the last frame that reported a fraction. */
  fraction: number;
  message: string;
  level: ProgressLevel;
  /** `streaming` until the run reaches an outcome. */
  status: AnalysisStatus | 'streaming';
}

export interface ProgressFrame {
  at: string;
  level: ProgressLevel;
  message: string;
  progress: number | null;
}

export const QUEUED: AnalysisProgress = {
  fraction: 0,
  message: 'Queued.',
  level: 'info',
  status: 'streaming',
};

/** Fold one frame into the current state. */
export function applyFrame(
  current: AnalysisProgress | null,
  frame: ProgressFrame
): AnalysisProgress {
  return {
    // A warning carries no fraction, and letting it reset the bar to zero would
    // read as the run starting over.
    fraction: frame.progress ?? current?.fraction ?? 0,
    message: frame.message,
    level: frame.level,
    status: 'streaming',
  };
}

/**
 * Fold in the frame that ends the stream.
 *
 * A successful run is shown as complete regardless of the last fraction
 * reported: the phases are approximations, and stopping the bar at 95% with
 * nothing left to do says the opposite of what happened.
 */
export function applyOutcome(
  current: AnalysisProgress | null,
  status: AnalysisStatus,
  error?: string | null
): AnalysisProgress {
  const succeeded = status === 'succeeded';

  return {
    fraction: succeeded ? 1 : (current?.fraction ?? 0),
    message: error ?? current?.message ?? '',
    level: succeeded ? 'info' : 'error',
    status,
  };
}

/** Parse a frame's `data`, treating anything malformed as no frame at all. */
export function parseFrame<T>(data: unknown): T | null {
  if (typeof data !== 'string') return null;

  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
