import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { apiFetch, apiUrl } from '@/lib/api/client';

import { readEventStream } from './sse';
import type { CopilotEvent, CopilotMessage } from './events';

/**
 * The copilot's client.
 *
 * A turn is a POST whose response body is the stream, which is why it cannot go
 * through `apiFetch`: that helper reads the whole body as JSON, and a turn's
 * value is in arriving a token at a time. Everything else here is ordinary.
 */

/** What the server refuses a turn with, so the UI can say why rather than "failed". */
export interface TurnRefusal {
  code: string;
  message: string;
  status: number;
}

export class TurnRefusedError extends Error {
  constructor(readonly refusal: TurnRefusal) {
    super(refusal.message);
    this.name = 'TurnRefusedError';
  }
}

export async function fetchTranscript(experimentId: string): Promise<CopilotMessage[]> {
  const { messages } = await apiFetch<{ messages: CopilotMessage[] }>(
    `/experiments/${experimentId}/copilot`
  );
  return messages;
}

export async function* sendTurn(
  experimentId: string,
  message: string,
  signal?: AbortSignal
): AsyncGenerator<CopilotEvent> {
  const response = await fetch(apiUrl(`/experiments/${experimentId}/copilot/messages`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message }),
    signal,
  });

  // Every refusal is decided before a frame is written, so a non-stream response
  // is a refusal with a reason rather than a broken stream to guess at.
  if (!response.ok || response.body === null) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw new TurnRefusedError({
      code: typeof body.code === 'string' ? body.code : 'unknown',
      message:
        typeof body.message === 'string'
          ? body.message
          : typeof body.error === 'string'
            ? body.error
            : 'The copilot could not answer.',
      status: response.status,
    });
  }

  yield* readEventStream(response.body, signal);
}

/**
 * Reattach to a turn already in flight, which is what a reload lands on.
 *
 * The server answers with a snapshot of everything so far and then the rest of
 * the events, so a client that missed frames nobody kept is repaired rather
 * than left showing half an answer.
 */
export async function* resumeTurn(
  experimentId: string,
  messageId: string,
  afterSeq: number,
  signal?: AbortSignal
): AsyncGenerator<CopilotEvent> {
  const response = await fetch(
    apiUrl(
      `/experiments/${experimentId}/copilot/messages/${messageId}/events?lastEventId=${messageId}:${afterSeq}`
    ),
    { credentials: 'include', headers: { Accept: 'text/event-stream' }, signal }
  );

  if (!response.ok || response.body === null) return;
  yield* readEventStream(response.body, signal);
}

export interface AcceptedPatch {
  outcome: 'applied' | 'already_applied' | 'awaiting_user_acceptance';
  ir: ArchitectureIr;
  irDigest: string;
  touchedNodeIds: string[];
}

/**
 * Accepting returns the architecture the patch produced, rather than a receipt.
 *
 * The canvas then adopts those exact bytes: the document the user was shown a
 * price for is the document they end up with, which it would not be if the
 * browser re-applied the patch itself and the two implementations ever drifted.
 */
export async function acceptProposal(
  experimentId: string,
  proposalId: string
): Promise<AcceptedPatch> {
  return apiFetch<AcceptedPatch>(
    `/experiments/${experimentId}/copilot/proposals/${proposalId}/accept`,
    { method: 'POST' }
  );
}

export async function rejectProposal(experimentId: string, proposalId: string): Promise<void> {
  await apiFetch(`/experiments/${experimentId}/copilot/proposals/${proposalId}/reject`, {
    method: 'POST',
  });
}
