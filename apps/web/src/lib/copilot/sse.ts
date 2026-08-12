import { parseCopilotEvent, type CopilotEvent } from './events';

/**
 * Read an event stream from a `fetch` response body.
 *
 * `EventSource` would do this, and cannot be used: it only issues GET requests,
 * and a turn begins with a POST because it has a message body. So the same wire
 * format is read by hand off the response stream.
 *
 * Only what this application's own endpoint emits is handled - `id`, `event`
 * and single-line `data`, with comment lines as keepalives. It is deliberately
 * not a general SSE implementation; a parser that also handled multi-line data
 * and retry negotiation would be more code defending against a server we write.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<CopilotEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted === true) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // A frame ends at a blank line. Anything after the last one is a partial
      // frame that the next chunk completes, so it stays in the buffer.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const event = parseFrame(frame);
        if (event !== null) yield event;

        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Releasing rather than cancelling: the caller may have aborted the request
    // already, and cancelling a reader on a stream that is gone throws.
    reader.releaseLock();
  }
}

/** The last `seq` seen, so a reconnect can ask for what it missed. */
export function seqOf(event: CopilotEvent): number {
  return event.seq;
}

function parseFrame(frame: string): CopilotEvent | null {
  let kind: string | null = null;
  let seq: number | null = null;
  let data: string | null = null;

  for (const line of frame.split('\n')) {
    // A comment line is the keepalive that stops an idle proxy closing the
    // connection. It carries nothing.
    if (line.startsWith(':')) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();

    if (field === 'event') kind = value;
    else if (field === 'data') data = value;
    else if (field === 'id') {
      // `<messageId>:<seq>`, and a message id may itself contain a colon, so the
      // sequence is taken from the last one.
      const cut = value.lastIndexOf(':');
      const parsed = Number(cut === -1 ? value : value.slice(cut + 1));
      seq = Number.isFinite(parsed) ? parsed : null;
    }
  }

  if (kind === null || seq === null || data === null) return null;
  return parseCopilotEvent(kind, seq, data);
}
