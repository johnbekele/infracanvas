/**
 * The agent-loop dashboard's HTTP surface: read the board, stream it live, and
 * the three controls (start, stop, release).
 *
 * The whole router is gated behind `isEnabled()` and returns 404 when off, so an
 * accidental production deploy does not expose process control. Auth is applied
 * router-wide because every path here reads or acts on the machine's loop, and
 * rate limiting matches the rest of the API.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../../middleware/auth.js';
import { apiRateLimit } from '../../middleware/rate-limit.js';
import { logError } from '../../lib/log.js';
import { isEnabled, resolveStateDir } from '../../lib/agent-loop/config.js';
import { FileLoopStateSource } from '../../lib/agent-loop/source.js';
import { streamBoard } from '../../lib/agent-loop/stream.js';
import {
  LoopAlreadyRunningError,
  releaseClaim,
  startLoop,
  stopLoop,
} from '../../lib/agent-loop/control.js';

const router: Router = Router();

const stateDir = resolveStateDir();
const source = new FileLoopStateSource(stateDir);

// Off in production unless explicitly enabled. A 404 rather than a 403 keeps the
// endpoint's very existence hidden where it should not be reachable.
router.use((_req, res, next) => {
  if (!isEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
});

router.use(apiRateLimit);
router.use(requireAuth);

/** A positive integer issue number from the path, or null. */
function issueParam(req: Request): number | null {
  const issue = Number(req.params.issue);
  return Number.isInteger(issue) && issue > 0 ? issue : null;
}

/** GET /agent-loop/board - the whole board once, for a first paint or a poll. */
router.get('/board', (_req: Request, res: Response) => {
  try {
    res.json(source.board());
  } catch (error) {
    logError('Failed to read agent-loop board', error);
    res.status(500).json({ error: 'Failed to read the loop state' });
  }
});

/** GET /agent-loop/stream - the board, pushed live over SSE. */
router.get('/stream', (req: Request, res: Response) => {
  streamBoard(req, res, source);
});

/** GET /agent-loop/runs/:issue/events?after=N - a run's events past a cursor. */
router.get('/runs/:issue/events', (req: Request, res: Response) => {
  const issue = issueParam(req);
  if (issue === null) {
    res.status(400).json({ error: 'issue must be a positive integer' });
    return;
  }
  const after = Number(req.query.after);
  try {
    res.json({ events: source.events(issue, Number.isInteger(after) ? after : 0) });
  } catch (error) {
    logError('Failed to read agent-loop run events', error);
    res.status(500).json({ error: 'Failed to read run events' });
  }
});

/** POST /agent-loop/start - spawn the loop, unless one is already running. */
router.post('/start', (_req: Request, res: Response) => {
  try {
    const pid = startLoop(stateDir);
    res.status(202).json({ pid });
  } catch (error) {
    if (error instanceof LoopAlreadyRunningError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logError('Failed to start the agent loop', error);
    res.status(500).json({ error: 'Failed to start the loop' });
  }
});

/** POST /agent-loop/stop - kill switch (graceful); `{ force: true }` also signals. */
router.post('/stop', (req: Request, res: Response) => {
  const force = (req.body as { force?: unknown })?.force === true;
  try {
    stopLoop(stateDir, force);
    res.json({ ok: true, force });
  } catch (error) {
    logError('Failed to stop the agent loop', error);
    res.status(500).json({ error: 'Failed to stop the loop' });
  }
});

/** POST /agent-loop/runs/:issue/release - drop a stale run's local claim. */
router.post('/runs/:issue/release', (req: Request, res: Response) => {
  const issue = issueParam(req);
  if (issue === null) {
    res.status(400).json({ error: 'issue must be a positive integer' });
    return;
  }
  try {
    res.json({ released: releaseClaim(stateDir, issue) });
  } catch (error) {
    logError('Failed to release an agent-loop claim', error);
    res.status(500).json({ error: 'Failed to release the claim' });
  }
});

export default router;
