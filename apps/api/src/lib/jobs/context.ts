/**
 * What a handler is given while it runs.
 *
 * Narrow on purpose: a handler can report and it can be told to stop, and it
 * cannot reach the queue to change its own status. Ownership of the lease decides
 * whether a result counts, and a handler that could mark itself succeeded would
 * be able to do so from under the worker that replaced it.
 */
import { appendEvent } from './queue.js';
import { logWarn } from '../log.js';
import type { JobContext, JobEventLevel } from './types.js';

export function createJobContext(jobId: string, signal: AbortSignal): JobContext {
  const write = async (level: JobEventLevel, message: string, progress?: number | null) => {
    try {
      await appendEvent(jobId, { level, message, progress });
    } catch (error) {
      // Progress is for the person watching. Failing to write a line is not a
      // reason to fail the work it was describing.
      logWarn('Failed to append job event', { jobId, cause: error });
    }
  };

  return {
    jobId,
    signal,
    progress: (fraction, message) => write('info', message, clamp(fraction)),
    log: (level, message) => write(level, message),
  };
}

/**
 * Keep a reported fraction inside the range the column allows.
 *
 * A handler computing `done / total` produces `NaN` when there is nothing to do,
 * and the check constraint would turn that into a failed job -- the work having
 * succeeded, and only the reporting of it having gone wrong.
 */
function clamp(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}
