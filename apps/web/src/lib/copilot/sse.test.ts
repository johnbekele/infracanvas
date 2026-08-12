import { describe, expect, it } from 'vitest';

import { readEventStream } from './sse';

/** Feeds bytes in whatever chunks a test asks for, including mid-frame splits. */
function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const events = [];
  for await (const event of readEventStream(stream(chunks))) events.push(event);
  return events;
}

const token = 'id: msg_1:1\nevent: token\ndata: {"text":"Right"}\n\n';
const done =
  'id: msg_1:2\nevent: done\ndata: {"finish":"complete","inputTokens":10,"outputTokens":4,' +
  '"toolCalls":1,"unverifiedCitations":0}\n\n';

describe('reading a copilot turn off a fetch response', () => {
  it('reassembles the kind and sequence the frame splits apart', async () => {
    const events = await collect([token]);

    expect(events).toEqual([{ kind: 'token', seq: 1, text: 'Right' }]);
  });

  it('does not emit a frame until the blank line that ends it arrives', async () => {
    // The interesting case, because a token arriving in two TCP reads is the
    // normal case rather than the edge one.
    const half = token.slice(0, 20);
    const rest = token.slice(20);

    expect(await collect([half])).toEqual([]);
    expect(await collect([half, rest])).toHaveLength(1);
  });

  it('reads several frames out of one chunk', async () => {
    const events = await collect([token + done]);

    expect(events.map((event) => event.kind)).toEqual(['token', 'done']);
  });

  it('ignores the keepalive comments that hold a connection open', async () => {
    const events = await collect([': keepalive\n\n', token]);

    expect(events).toHaveLength(1);
  });

  it('ignores the retry preamble, which is not an event', async () => {
    const events = await collect([`retry: 3000\n\n${token}`]);

    expect(events).toHaveLength(1);
  });

  it('drops a kind this build does not know rather than ending the turn', async () => {
    const unknown = 'id: msg_1:1\nevent: telepathy\ndata: {}\n\n';
    const events = await collect([unknown, done]);

    expect(events.map((event) => event.kind)).toEqual(['done']);
  });

  it('drops a frame whose data is not JSON', async () => {
    const events = await collect(['id: msg_1:1\nevent: token\ndata: {oops\n\n', done]);

    expect(events.map((event) => event.kind)).toEqual(['done']);
  });

  it('takes the sequence from the last colon, since a message id may contain one', async () => {
    const events = await collect(['id: exp:msg:7\nevent: token\ndata: {"text":"x"}\n\n']);

    expect(events[0]?.seq).toBe(7);
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    const events = [];
    for await (const event of readEventStream(stream([token, done]), controller.signal)) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });
});
