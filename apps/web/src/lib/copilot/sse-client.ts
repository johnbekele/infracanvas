import type { CopilotEvent, CopilotMessage, PatchPreview } from './types';

export interface TurnHandlers {
  onEvent(event: CopilotEvent): void;
  /** Called once, with a code the UI can branch on, when the turn cannot start. */
  onRefusal(refusal: { status: number; code: string; message: string }): void;
  onClose(finish: 'complete' | 'limit' | 'cancelled' | 'error'): void;
}

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_API_URL || '';
  return base ? `${base}${path}` : `/api${path}`;
}

/**
 * Starts a turn. A POST cannot be an `EventSource`, so the stream is read from
 * `fetch` with a `ReadableStream`; frames are reassembled across chunk
 * boundaries, which is the bug every hand-rolled SSE reader has.
 *
 * Aborting closes the request, which is what makes the server cancel the run
 * rather than finish it into a void.
 */
export async function startTurn(
  experimentId: string,
  message: string,
  handlers: TurnHandlers,
  signal: AbortSignal
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(apiUrl(`/experiments/${experimentId}/copilot/messages`), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ message }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      handlers.onClose('cancelled');
      return;
    }
    handlers.onClose('error');
    throw error;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      error?: string;
      message?: string;
    };
    handlers.onRefusal({
      status: response.status,
      code: body.code ?? 'error',
      message: body.message ?? body.error ?? `Request failed (${response.status})`,
    });
    handlers.onClose('error');
    return;
  }

  const body = response.body;
  if (!body) {
    handlers.onClose('error');
    return;
  }

  const finish = await readSseStream(body, handlers, signal);
  handlers.onClose(finish);
}

/**
 * Reattaches to a turn after a dropped connection, using `EventSource` on the
 * GET route so the browser's own reconnection and `Last-Event-ID` handling do
 * the work. The first event is a `snapshot` that replaces the local message.
 */
export function resumeTurn(
  experimentId: string,
  messageId: string,
  handlers: TurnHandlers
): () => void {
  const url = apiUrl(`/experiments/${experimentId}/copilot/messages/${messageId}/events`);
  const source = new EventSource(url, { withCredentials: true });
  let closed = false;

  const close = (finish: 'complete' | 'limit' | 'cancelled' | 'error') => {
    if (closed) return;
    closed = true;
    source.close();
    handlers.onClose(finish);
  };

  const onNamed = (kind: string) => (ev: MessageEvent<string>) => {
    const parsed = frameToEvent(kind, ev.data, ev.lastEventId);
    if (!parsed) return;
    handlers.onEvent(parsed);
    if (parsed.kind === 'done') {
      close(parsed.finish);
    }
  };

  for (const kind of [
    'token',
    'citation',
    'tool_call',
    'tool_result',
    'patch_proposed',
    'limit',
    'error',
    'done',
    'snapshot',
  ]) {
    source.addEventListener(kind, onNamed(kind) as EventListener);
  }

  source.onerror = () => {
    if (closed) return;
    // EventSource reconnects on its own for transient drops; a hard failure
    // after the stream ended is reported once.
    if (source.readyState === EventSource.CLOSED) {
      close('error');
    }
  };

  return () => close('cancelled');
}

async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  handlers: TurnHandlers,
  signal: AbortSignal
): Promise<'complete' | 'limit' | 'cancelled' | 'error'> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finish: 'complete' | 'limit' | 'cancelled' | 'error' = 'complete';
  let openedMessageId: string | null = null;

  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        return 'cancelled';
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';

      for (const raw of parts) {
        const frame = parseSseFrame(raw);
        if (!frame) continue;

        if (
          openedMessageId === null &&
          frame.messageId &&
          frame.event !== 'snapshot' &&
          frame.event !== null
        ) {
          openedMessageId = frame.messageId;
          handlers.onEvent({
            kind: 'snapshot',
            seq: 0,
            message: emptyStreamingMessage(frame.messageId),
          });
        }

        const event = frameToEvent(frame.event, frame.data, frame.id);
        if (!event) continue;
        handlers.onEvent(event);
        if (event.kind === 'done') {
          finish = event.finish;
        }
      }
    }
  } catch (error) {
    if (signal.aborted) return 'cancelled';
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }

  return signal.aborted ? 'cancelled' : finish;
}

interface ParsedFrame {
  id: string | null;
  event: string | null;
  data: string;
  messageId: string | null;
}

/**
 * Field order is not guaranteed: a proxy or a writer may emit `data` before
 * `id`. Accumulate every line, then interpret.
 */
export function parseSseFrame(raw: string): ParsedFrame | null {
  const lines = raw.split(/\r?\n/);
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (event === null && dataLines.length === 0 && id === null) {
    return null;
  }

  const messageId = id?.includes(':') ? id.slice(0, id.lastIndexOf(':')) : id;

  return {
    id,
    event,
    data: dataLines.join('\n'),
    messageId: messageId || null,
  };
}

export function frameToEvent(
  eventName: string | null,
  data: string,
  id: string | null
): CopilotEvent | null {
  if (!eventName) return null;

  let payload: Record<string, unknown> = {};
  if (data.length > 0) {
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const seqFromId = id?.includes(':') ? Number(id.slice(id.lastIndexOf(':') + 1)) : NaN;
  const seq =
    typeof payload.seq === 'number' ? payload.seq : Number.isFinite(seqFromId) ? seqFromId : 0;

  switch (eventName) {
    case 'token':
      return { kind: 'token', seq, text: String(payload.text ?? '') };
    case 'citation':
      return {
        kind: 'citation',
        seq,
        scheme: payload.scheme as 'file' | 'sku' | 'prediction',
        target: String(payload.target ?? ''),
        verified: Boolean(payload.verified),
        reason: (payload.reason as string | null | undefined) ?? null,
      };
    case 'tool_call':
      return {
        kind: 'tool_call',
        seq,
        callId: String(payload.callId ?? payload.call_id ?? ''),
        tool: String(payload.tool ?? ''),
        summary: String(payload.summary ?? ''),
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        seq,
        callId: String(payload.callId ?? payload.call_id ?? ''),
        tool: String(payload.tool ?? ''),
        ok: Boolean(payload.ok),
        summary: String(payload.summary ?? ''),
        durationMs: Number(payload.durationMs ?? payload.duration_ms ?? 0),
      };
    case 'patch_proposed':
      return {
        kind: 'patch_proposed',
        seq,
        proposalId: String(payload.proposalId ?? payload.proposal_id ?? ''),
        patchDigest: String(payload.patchDigest ?? payload.patch_digest ?? ''),
        summary: String(payload.summary ?? ''),
        touchedNodeIds: Array.isArray(payload.touchedNodeIds)
          ? (payload.touchedNodeIds as string[])
          : Array.isArray(payload.touched_node_ids)
            ? (payload.touched_node_ids as string[])
            : [],
        preview: payload.preview as PatchPreview,
        operations: Array.isArray(payload.operations)
          ? (payload.operations as string[])
          : undefined,
      };
    case 'limit':
      return {
        kind: 'limit',
        seq,
        limit: String(payload.limit ?? ''),
        message: String(payload.message ?? ''),
      };
    case 'error':
      return {
        kind: 'error',
        seq,
        code: String(payload.code ?? 'error'),
        message: String(payload.message ?? ''),
      };
    case 'done':
      return {
        kind: 'done',
        seq,
        finish: (payload.finish as 'complete' | 'limit' | 'cancelled' | 'error') ?? 'complete',
        inputTokens: Number(payload.inputTokens ?? payload.input_tokens ?? 0),
        outputTokens: Number(payload.outputTokens ?? payload.output_tokens ?? 0),
        toolCalls: Number(payload.toolCalls ?? payload.tool_calls ?? 0),
        unverifiedCitations: Number(
          payload.unverifiedCitations ?? payload.unverified_citations ?? 0
        ),
      };
    case 'snapshot':
      return {
        kind: 'snapshot',
        seq,
        message: payload.message as CopilotMessage,
      };
    default:
      return null;
  }
}

function emptyStreamingMessage(id: string): CopilotMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    toolCalls: [],
    citations: [],
    proposal: null,
    status: 'streaming',
    unverifiedCitations: 0,
  };
}
