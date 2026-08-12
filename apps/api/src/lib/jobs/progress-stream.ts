/**
 * Streaming a job's progress to the browser.
 *
 * The stream is served by reading the job's event log, not by subscribing to the
 * worker. That decoupling is the point. Every API process can serve the stream
 * for a job running in whichever worker claimed it, the log reads the same live
 * or an hour later, and a reconnecting client resumes from an id rather than
 * from whatever the worker happens to still hold in memory.
 *
 * Polling the log is the deliberately boring choice. `LISTEN`/`NOTIFY` would
 * remove the poll, at the cost of a dedicated connection per stream held outside
 * the pool -- a real constraint against a pooler, for a saving of at most one
 * second on a job that takes tens.
 */
import type { Request, Response } from 'express';
import { findAnalysis, type AnalysisStatus } from '../db/analyses.js';
import { findJobForAnalysis, readEvents } from './queue.js';
import type { JobEvent } from './types.js';
import { logError } from '../log.js';

export interface StreamOptions {
  pollIntervalMs: number;
  /** Comment frames, which keep a proxy from closing an idle stream as dead. */
  heartbeatMs: number;
  /**
   * How long a stream may stay open.
   *
   * A tab left open overnight otherwise holds a connection and polls the database
   * once a second forever. The client reconnects if it still cares and resumes
   * from where it left off, so the cap costs a round trip rather than progress.
   */
  maxStreamMs: number;
}

const DEFAULTS: StreamOptions = {
  pollIntervalMs: 1_000,
  heartbeatMs: 15_000,
  maxStreamMs: 10 * 60 * 1000,
};

const TERMINAL: readonly AnalysisStatus[] = ['succeeded', 'failed'];

function write(res: Response, event: string, data: unknown, id?: number): void {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  // JSON.stringify cannot emit a raw newline, so the payload is always one
  // `data:` line and cannot be split into a forged second frame by its contents.
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function toFrame(event: JobEvent): Record<string, unknown> {
  return {
    at: event.at.toISOString(),
    level: event.level,
    message: event.message,
    progress: event.progress,
  };
}

/**
 * Where to resume from.
 *
 * `Last-Event-ID` is set by the browser on an automatic reconnect; the query
 * parameter is for a client that reconnects deliberately. Anything unparseable
 * means start from the beginning, which replays rather than skips -- the failure
 * a user can see and dismiss, not the one that silently loses a line.
 */
function resumeFrom(req: Request): number | undefined {
  const header = req.get('Last-Event-ID') ?? req.query.lastEventId;
  const parsed = Number(typeof header === 'string' ? header : NaN);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function streamAnalysisProgress(
  req: Request,
  res: Response,
  analysisId: string,
  overrides: Partial<StreamOptions> = {}
): Promise<void> {
  const options = { ...DEFAULTS, ...overrides };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx and the platform routers built on it buffer a proxied response by
    // default, which holds every frame until the stream ends and delivers the
    // whole run at the moment it stops being useful.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let cursor = resumeFrom(req);
  let open = true;

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), options.heartbeatMs);
  const deadline = setTimeout(() => {
    write(res, 'timeout', { message: 'The stream was closed. Reconnect to keep watching.' });
    close();
  }, options.maxStreamMs);

  function close(): void {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    res.end();
  }

  // A client that navigated away is the ordinary end of a stream, not an error.
  req.on('close', close);

  try {
    // The run reached a terminal state, but the log is drained one more time
    // before saying so. The worker writes its closing line just after the status
    // changes, and ending here on the first sight of `succeeded` would drop it.
    let draining = false;

    while (open) {
      const analysis = await findAnalysis(analysisId);
      if (!analysis) {
        write(res, 'error', { message: 'This analysis no longer exists.' });
        break;
      }

      const job = await findJobForAnalysis(analysisId);
      if (job) {
        const events = await readEvents(job.id, cursor);
        for (const event of events) {
          write(res, 'progress', toFrame(event), event.id);
          cursor = event.id;
        }
      }

      if (draining) {
        write(res, analysis.status === 'succeeded' ? 'succeeded' : 'failed', {
          analysisId,
          status: analysis.status,
          error: analysis.error,
        });
        break;
      }

      if (TERMINAL.includes(analysis.status)) {
        draining = true;
        // Long enough for the closing line to land, short enough that the user
        // does not watch a finished run for another second.
        await sleep(options.pollIntervalMs / 4);
        continue;
      }

      await sleep(options.pollIntervalMs);
    }
  } catch (error) {
    logError('Analysis progress stream failed', error);
    // Headers are long gone, so there is no status code left to set. Saying so
    // in a frame at least lets the client stop waiting and refetch.
    if (open) write(res, 'error', { message: 'The progress stream failed. Reload to try again.' });
  } finally {
    close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
