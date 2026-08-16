/**
 * Server-sent stream of the whole board. The loop's state lives in files that
 * change many times a second, so this polls the source on a timer and pushes a
 * frame only when the serialised board actually changed, with heartbeats to keep
 * a proxy from dropping an idle connection and a cap so a forgotten tab does not
 * poll forever.
 */

import type { Request, Response } from 'express';

import { logError } from '../log.js';
import type { LoopStateSource } from './types.js';

export interface StreamOptions {
  pollIntervalMs: number;
  heartbeatMs: number;
  maxStreamMs: number;
}

const DEFAULTS: StreamOptions = {
  pollIntervalMs: 1_500,
  heartbeatMs: 15_000,
  maxStreamMs: 30 * 60 * 1000,
};

function write(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function streamBoard(
  req: Request,
  res: Response,
  source: LoopStateSource,
  overrides: Partial<StreamOptions> = {}
): void {
  const options = { ...DEFAULTS, ...overrides };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let lastSerialised = '';
  let open = true;

  const push = (): void => {
    if (!open) return;
    try {
      const board = source.board();
      const serialised = JSON.stringify(board);
      if (serialised !== lastSerialised) {
        lastSerialised = serialised;
        write(res, 'board', board);
      }
    } catch (error) {
      logError('Agent-loop board stream failed to read state', error);
    }
  };

  const poll = setInterval(push, options.pollIntervalMs);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), options.heartbeatMs);
  const deadline = setTimeout(() => {
    write(res, 'timeout', { message: 'The stream was closed. Reconnect to keep watching.' });
    close();
  }, options.maxStreamMs);

  function close(): void {
    if (!open) return;
    open = false;
    clearInterval(poll);
    clearInterval(heartbeat);
    clearTimeout(deadline);
    res.end();
  }

  req.on('close', close);

  // Send the current board at once, so a fresh connection is not blank until the
  // first tick.
  push();
}
