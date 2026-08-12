import type { Response } from 'express';

import type { CopilotEvent } from './events.js';

/**
 * The framing a browser reads.
 *
 * Server-sent events rather than websockets, for the reasons #29 settled: the
 * traffic is one-directional, SSE survives proxies that mangle a websocket
 * upgrade, and the browser reconnects on its own. The one thing that surface
 * did not have to solve is that a turn starts with a POST, because there is a
 * message body, while `EventSource` is GET-only. So the turn streams from the
 * POST and resumption is a separate GET - which is why every frame carries
 * `id: <messageId>:<seq>` and the message row records where a reader got to.
 */

/** A comment line at this interval, matching what #29 established. */
export const KEEPALIVE_MS = 15_000;

/** How long a browser waits before reconnecting, in the retry field. */
export const RETRY_MS = 2_000;

export function openStream(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx buffers a proxied response by default, which would hold every token
    // until the turn finished and make the stream pointless.
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: ${RETRY_MS}\n\n`);
}

export function writeEvent(res: Response, messageId: string, event: CopilotEvent): void {
  const { kind, seq, ...payload } = event;
  res.write(`id: ${messageId}:${seq}\nevent: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function writeKeepalive(res: Response): void {
  res.write(': keepalive\n\n');
}

/** The sequence a resuming client has already seen, from `Last-Event-ID`. */
export function seqFromLastEventId(header: string | undefined): number {
  if (header === undefined) return 0;
  const seq = Number.parseInt(header.slice(header.lastIndexOf(':') + 1), 10);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

type Subscriber = (event: CopilotEvent) => void;

/**
 * In-process fan-out from a running turn to a reader that reconnected.
 *
 * Single-instance, for the same reason the rate-limit store is. Behind two
 * instances a resume that lands on the wrong process gets the snapshot and then
 * polls the message row until its status leaves `streaming`: correct, just less
 * live. Making it correct across processes needs a broker, and a broker for the
 * laptop-lid case is not a trade worth making yet.
 */
export class TurnBroadcaster {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  publish(messageId: string, event: CopilotEvent): void {
    for (const subscriber of this.subscribers.get(messageId) ?? []) subscriber(event);
  }

  /** Every event published after `afterSeq`, until the turn's `done`. */
  async *subscribe(messageId: string, afterSeq: number): AsyncIterable<CopilotEvent> {
    const queue: CopilotEvent[] = [];
    let wake: (() => void) | null = null;

    const subscriber: Subscriber = (event) => {
      if (event.seq <= afterSeq) return;
      queue.push(event);
      wake?.();
    };

    const set = this.subscribers.get(messageId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(messageId, set);

    try {
      while (true) {
        while (queue.length > 0) {
          const event = queue.shift() as CopilotEvent;
          yield event;
          if (event.kind === 'done') return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(messageId);
    }
  }

  /** Whether a turn is still being written to, which decides if a resume waits. */
  live(messageId: string): boolean {
    return (this.subscribers.get(messageId)?.size ?? 0) > 0;
  }
}

export const turns = new TurnBroadcaster();
