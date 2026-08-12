import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { CopilotEvent } from './events.js';
import {
  KEEPALIVE_MS,
  seqFromLastEventId,
  TurnBroadcaster,
  writeEvent,
  writeKeepalive,
} from './stream.js';

function fakeResponse(): { res: Response; written: string[] } {
  const written: string[] = [];
  const res = {
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  } as unknown as Response;
  return { res, written };
}

const token = (seq: number, text: string): CopilotEvent => ({ kind: 'token', seq, text });

describe('the wire format', () => {
  it('frames an event with an id a client can resume from', () => {
    const { res, written } = fakeResponse();

    writeEvent(res, '9f1c', token(41, 'Multi-AZ raises the monthly cost by '));

    expect(written[0]).toBe(
      'id: 9f1c:41\nevent: token\ndata: {"text":"Multi-AZ raises the monthly cost by "}\n\n'
    );
  });

  it('reads the sequence back out of a Last-Event-ID header', () => {
    expect(seqFromLastEventId('9f1c:41')).toBe(41);
    expect(seqFromLastEventId(undefined)).toBe(0);
    expect(seqFromLastEventId('nonsense')).toBe(0);
  });

  it('emits a keepalive as a comment, which no client parses as an event', () => {
    const { res, written } = fakeResponse();

    writeKeepalive(res);

    expect(written[0]).toBe(': keepalive\n\n');
    expect(written[0]).not.toContain('event:');
  });

  it('emits a keepalive on an idle stream inside twenty seconds', () => {
    vi.useFakeTimers();
    const { res, written } = fakeResponse();
    const timer = setInterval(() => writeKeepalive(res), KEEPALIVE_MS);

    try {
      vi.advanceTimersByTime(20_000);
      expect(written.length).toBeGreaterThanOrEqual(1);
    } finally {
      clearInterval(timer);
      vi.useRealTimers();
    }
  });
});

describe('the turn broadcaster', () => {
  it('delivers only events after the sequence the client already has', async () => {
    const broadcaster = new TurnBroadcaster();
    const received: CopilotEvent[] = [];

    const reader = (async () => {
      for await (const event of broadcaster.subscribe('m1', 2)) received.push(event);
    })();

    await Promise.resolve();
    broadcaster.publish('m1', token(1, 'already seen'));
    broadcaster.publish('m1', token(2, 'also seen'));
    broadcaster.publish('m1', token(3, 'new'));
    broadcaster.publish('m1', {
      kind: 'done',
      seq: 4,
      finish: 'complete',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      unverifiedCitations: 0,
    });
    await reader;

    // No replayed tokens: what a resuming client missed comes from the
    // snapshot, and what it has already seen is never sent twice.
    expect(received.map((event) => event.seq)).toEqual([3, 4]);
  });

  it('ends a subscription when the turn is done', async () => {
    const broadcaster = new TurnBroadcaster();

    const reader = (async () => {
      const seen: number[] = [];
      for await (const event of broadcaster.subscribe('m2', 0)) seen.push(event.seq);
      return seen;
    })();

    await Promise.resolve();
    broadcaster.publish('m2', {
      kind: 'done',
      seq: 1,
      finish: 'cancelled',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      unverifiedCitations: 0,
    });

    await expect(reader).resolves.toEqual([1]);
    expect(broadcaster.live('m2')).toBe(false);
  });

  it('delivers one turn to two readers without either seeing the other\u2019s', async () => {
    const broadcaster = new TurnBroadcaster();
    const collect = (after: number) =>
      (async () => {
        const seen: number[] = [];
        for await (const event of broadcaster.subscribe('m3', after)) seen.push(event.seq);
        return seen;
      })();

    const first = collect(0);
    const second = collect(1);
    await Promise.resolve();

    broadcaster.publish('m3', token(1, 'one'));
    broadcaster.publish('m3', token(2, 'two'));
    broadcaster.publish('m3', {
      kind: 'done',
      seq: 3,
      finish: 'complete',
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      unverifiedCitations: 0,
    });

    await expect(first).resolves.toEqual([1, 2, 3]);
    await expect(second).resolves.toEqual([2, 3]);
  });
});
