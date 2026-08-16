import { afterEach, describe, expect, it, vi } from 'vitest';

import { frameToEvent, parseSseFrame, startTurn, type TurnHandlers } from './sse-client';

function handlers(): TurnHandlers & {
  events: unknown[];
  refusals: unknown[];
  closes: unknown[];
} {
  const events: unknown[] = [];
  const refusals: unknown[] = [];
  const closes: unknown[] = [];
  return {
    events,
    refusals,
    closes,
    onEvent: (e) => events.push(e),
    onRefusal: (r) => refusals.push(r),
    onClose: (f) => closes.push(f),
  };
}

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sse-client', () => {
  it('reassembles an event split across two stream chunks', async () => {
    const h = handlers();
    const chunks = [
      'id: msg-1:1\nevent: token\ndata: {"text":"Hel',
      'lo"}\n\nid: msg-1:2\nevent: done\ndata: {"finish":"complete","inputTokens":1,"outputTokens":1,"toolCalls":0,"unverifiedCitations":0}\n\n',
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        body: streamFrom(chunks),
        json: async () => ({}),
      }))
    );

    await startTurn('exp-1', 'hi', h, new AbortController().signal);

    expect(h.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'snapshot',
          message: expect.objectContaining({ id: 'msg-1' }),
        }),
        { kind: 'token', seq: 1, text: 'Hello' },
        expect.objectContaining({ kind: 'done', finish: 'complete' }),
      ])
    );
    expect(h.closes).toEqual(['complete']);
  });

  it('reassembles a frame whose data field arrives before its id', () => {
    const frame = parseSseFrame('event: token\ndata: {"text":"Hi","seq":7}\nid: msg-9:7');
    expect(frame).toEqual({
      id: 'msg-9:7',
      event: 'token',
      data: '{"text":"Hi","seq":7}',
      messageId: 'msg-9',
    });
    expect(frameToEvent(frame!.event, frame!.data, frame!.id)).toEqual({
      kind: 'token',
      seq: 7,
      text: 'Hi',
    });
  });

  it('reports a refusal status without emitting any event', async () => {
    const h = handlers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        body: null,
        json: async () => ({
          code: 'no_llm_credential',
          message: 'Add a model credential in settings.',
        }),
      }))
    );

    await startTurn('exp-1', 'hi', h, new AbortController().signal);

    expect(h.events).toEqual([]);
    expect(h.refusals).toEqual([
      {
        status: 409,
        code: 'no_llm_credential',
        message: 'Add a model credential in settings.',
      },
    ]);
    expect(h.closes).toEqual(['error']);
  });

  it('stops reading when the abort signal fires', async () => {
    const h = handlers();
    const controller = new AbortController();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(ctrl) {
              const encoder = new TextEncoder();
              ctrl.enqueue(
                encoder.encode('id: msg-1:1\nevent: token\ndata: {"text":"partial"}\n\n')
              );
              signal?.addEventListener('abort', () => {
                ctrl.error(new DOMException('Aborted', 'AbortError'));
              });
            },
          }),
          json: async () => ({}),
        };
      })
    );

    const turn = startTurn('exp-1', 'hi', h, controller.signal);
    controller.abort();
    await turn;

    expect(h.closes).toContain('cancelled');
    expect(h.events.some((e) => (e as { kind: string }).kind === 'done')).toBe(false);
  });
});
