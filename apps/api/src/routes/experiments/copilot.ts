import { Router, type Request, type Response } from 'express';

import { copilotDeps } from '../../lib/copilot/deps.js';
import { ExperimentNotFoundError } from '../../lib/copilot/errors.js';
import type { CopilotEvent } from '../../lib/copilot/events.js';
import { checkPreconditions, runTurn, type TurnRequest } from '../../lib/copilot/run.js';
import {
  KEEPALIVE_MS,
  openStream,
  seqFromLastEventId,
  turns,
  writeEvent,
  writeKeepalive,
} from '../../lib/copilot/stream.js';
import { TurnAlreadyStreamingError } from '../../lib/copilot/transcript.js';
import { copilotTurnRateLimit } from '../../middleware/rate-limit.js';
import { logError } from '../../lib/log.js';
import { chatModelFor, copilotPlatform } from './platform.js';

/**
 * The copilot's public surface.
 *
 * A turn starts with a POST, because there is a message body, and streams its
 * answer from that response; `EventSource` is GET-only, so resumption is a
 * separate GET that replays a snapshot and then attaches to the live turn. That
 * split is the reason every frame carries `id: <messageId>:<seq>`.
 *
 * Text is persisted as the turn proceeds rather than at the end, so a turn
 * killed halfway leaves what the user already read rather than an empty row.
 * The persisted state is also what a reconnecting client is handed, which
 * repairs a client that missed events nobody can replay.
 */

const router: Router = Router({ mergeParams: true });

/** At most four writes a second, however fast the tokens arrive. */
const PERSIST_INTERVAL_MS = 250;
const PERSIST_CHARS = 512;

function scopeOf(req: Request): { experimentId: string; userId: string } {
  return { experimentId: req.params.experimentId, userId: req.session?.userId ?? '' };
}

router.get('/', async (req: Request, res: Response) => {
  const { store, transcript } = copilotPlatform();
  const scope = scopeOf(req);

  try {
    // Proving the experiment is the caller's before reading anything else: a
    // transcript is as private as the architecture it is about.
    await store.experiment(scope);
    res.json({ messages: await transcript.messages(scope) });
  } catch (error) {
    if (error instanceof ExperimentNotFoundError) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    logError('Reading a copilot transcript failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/messages', copilotTurnRateLimit, async (req: Request, res: Response) => {
  const { store, transcript, preview } = copilotPlatform();
  const scope = scopeOf(req);
  const body = (req.body ?? {}) as { message?: unknown; history?: unknown };

  if (typeof body.message !== 'string' || body.message.trim() === '') {
    res.status(400).json({ error: 'A turn needs a message.' });
    return;
  }
  if (body.message.length > 8000) {
    res.status(400).json({ error: 'That message is too long.' });
    return;
  }

  const deps = copilotDeps(scope, store, preview);

  // Everything that can refuse the turn is decided here, before a single frame
  // is written, so a refusal reaches the client as a status code it can branch
  // on rather than as an error event inside a 200.
  const precondition = await checkPreconditions(deps, await chatModelFor(scope.userId));
  if ('code' in precondition) {
    res
      .status(precondition.status)
      .json({ code: precondition.code, message: precondition.message });
    return;
  }

  const history = (await transcript.messages(scope)).map((message) => ({
    role: message.role,
    content: message.content,
  }));

  let assistant;
  try {
    await transcript.append(scope, { role: 'user', content: body.message, status: 'complete' });
    assistant = await transcript.append(scope, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
  } catch (error) {
    if (error instanceof TurnAlreadyStreamingError) {
      res.status(409).json({
        code: 'turn_in_progress',
        message: 'This conversation already has a turn in flight.',
      });
      return;
    }
    throw error;
  }

  // A closed connection, watched rather than polled: `req.destroyed` is true as
  // soon as the body parser has consumed the request, so it says nothing about
  // whether anyone is still reading. `close` on the response fires when the
  // client goes away, and during a turn nothing else ends it.
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
  });

  const turn: TurnRequest = { message: body.message, history };
  await stream(
    res,
    assistant.id,
    scope,
    runTurn(precondition, turn, () => clientGone)
  );
});

router.get('/messages/:messageId/events', async (req: Request, res: Response) => {
  const { store, transcript } = copilotPlatform();
  const scope = scopeOf(req);

  try {
    await store.experiment(scope);
  } catch {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const message = await transcript.message(scope, req.params.messageId);
  if (message === null) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // The header is what `EventSource` sends on its own; the query parameter is
  // for a client that cannot set one, such as a browser reconnecting by hand.
  const after = seqFromLastEventId(req.headers['last-event-id'] ?? req.query.lastEventId);

  openStream(res);
  // One snapshot, always: it is what repairs a client that missed events which
  // will never be sent again, and it is cheaper than replaying a token history
  // nobody kept.
  writeEvent(res, message.id, {
    kind: 'snapshot',
    seq: message.lastEventSeq,
    message,
  });

  if (message.status !== 'streaming') {
    // A finished turn is answered without waiting: the snapshot is the whole
    // of it.
    writeEvent(res, message.id, {
      kind: 'done',
      seq: message.lastEventSeq + 1,
      finish: message.status === 'complete' ? 'complete' : message.status,
      inputTokens: message.inputTokens,
      outputTokens: message.outputTokens,
      toolCalls: message.toolCalls.length,
      unverifiedCitations: message.unverifiedCitations,
    });
    res.end();
    return;
  }

  const keepalive = setInterval(() => writeKeepalive(res), KEEPALIVE_MS);
  try {
    for await (const event of turns.subscribe(message.id, after)) {
      writeEvent(res, message.id, event);
    }
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

/**
 * Write the turn to the client, to the broadcaster and to the transcript at
 * once, so all three see the same events in the same order.
 */
async function stream(
  res: Response,
  messageId: string,
  scope: { experimentId: string; userId: string },
  events: AsyncGenerator<CopilotEvent>
): Promise<void> {
  const { transcript } = copilotPlatform();
  openStream(res);
  const keepalive = setInterval(() => writeKeepalive(res), KEEPALIVE_MS);

  let content = '';
  let persisted = '';
  let persistedAt = Date.now();
  let lastSeq = 0;

  const toolCalls: NonNullable<Parameters<typeof transcript.update>[2]['toolCalls']> = [];
  const citations: NonNullable<Parameters<typeof transcript.update>[2]['citations']> = [];

  try {
    for await (const event of events) {
      lastSeq = event.seq;
      writeEvent(res, messageId, event);
      turns.publish(messageId, event);

      if (event.kind === 'token') {
        content += event.text;
        const due =
          content.length - persisted.length >= PERSIST_CHARS ||
          Date.now() - persistedAt >= PERSIST_INTERVAL_MS;
        if (due) {
          persisted = content;
          persistedAt = Date.now();
          await transcript.update(scope, messageId, { content, lastEventSeq: lastSeq });
        }
        continue;
      }

      // Everything that is not a token is small and is what a snapshot is made
      // of, so it is written as it arrives.
      if (event.kind === 'citation') {
        citations.push({
          scheme: event.scheme,
          target: event.target,
          verified: event.verified,
          reason: event.reason,
        });
        await transcript.update(scope, messageId, { citations, lastEventSeq: lastSeq });
      } else if (event.kind === 'tool_result') {
        toolCalls.push({
          callId: event.callId,
          tool: event.tool,
          summary: event.summary,
          ok: event.ok,
          durationMs: event.durationMs,
        });
        await transcript.update(scope, messageId, { toolCalls, lastEventSeq: lastSeq });
      } else if (event.kind === 'patch_proposed') {
        await transcript.update(scope, messageId, {
          proposalId: event.proposalId,
          lastEventSeq: lastSeq,
        });
      } else if (event.kind === 'done') {
        await transcript.update(scope, messageId, {
          content,
          status: event.finish === 'complete' ? 'complete' : event.finish,
          lastEventSeq: lastSeq,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          unverifiedCitations: event.unverifiedCitations,
        });
      }
    }
  } catch (error) {
    logError('A copilot turn failed', error);
    const failure: CopilotEvent = {
      kind: 'error',
      seq: lastSeq + 1,
      code: 'internal',
      message: 'The turn stopped unexpectedly.',
    };
    writeEvent(res, messageId, failure);
    turns.publish(messageId, failure);
    await transcript.update(scope, messageId, {
      content,
      status: 'error',
      errorCode: 'internal',
      lastEventSeq: failure.seq,
    });
  } finally {
    clearInterval(keepalive);
    // A client that went away leaves the message where the turn stopped rather
    // than as an eternally streaming row nothing will ever finish.
    const settled = await transcript.message(scope, messageId);
    if (settled?.status === 'streaming') {
      await transcript.update(scope, messageId, { content, status: 'cancelled' });
    }
    res.end();
  }
}

export default router;
