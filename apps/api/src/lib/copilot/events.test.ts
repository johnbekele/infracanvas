import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseCopilotEvent, type CopilotEvent } from './events.js';

/**
 * One committed line per event kind.
 *
 * The epic keeps the door open for a second implementation of the run loop in
 * another language, and a field added on one side and not the other has to fail
 * a test rather than a user's chat panel. Pinning the union to a file is how
 * that boundary is held; the file is written from this suite so it cannot drift
 * from the type it documents.
 */

const FIXTURE = new URL('../../../../../fixtures/copilot/events.example.jsonl', import.meta.url);

const EXAMPLES: CopilotEvent[] = [
  { kind: 'token', seq: 1, text: 'Multi-AZ raises the monthly cost by ' },
  {
    kind: 'citation',
    seq: 2,
    scheme: 'prediction',
    target: '945c3e36b14430b6c7a66382e6e71a6dc1fc9008c8a86f628258674df45a8158',
    verified: true,
    reason: null,
  },
  {
    kind: 'tool_call',
    seq: 3,
    callId: 'call_1',
    tool: 'price_change',
    summary: 'Pricing a change of 1 operation',
  },
  {
    kind: 'tool_result',
    seq: 4,
    callId: 'call_1',
    tool: 'price_change',
    ok: true,
    summary: '$15.44 a month more',
    durationMs: 4,
  },
  {
    kind: 'limit',
    seq: 5,
    limit: 'tool_calls',
    message: 'This turn reached its ceiling of 12 tool calls.',
  },
  {
    kind: 'error',
    seq: 6,
    code: 'provider_error',
    message: 'The model provider refused the request (401).',
  },
  {
    kind: 'done',
    seq: 7,
    finish: 'complete',
    inputTokens: 1840,
    outputTokens: 214,
    toolCalls: 1,
    unverifiedCitations: 0,
  },
];

describe('the committed event fixture', () => {
  it('parses every line of the committed brain event fixture', () => {
    const lines = EXAMPLES.map((event) => JSON.stringify(event));

    if (process.env.UPDATE_FIXTURES === '1') {
      mkdirSync(new URL('.', FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, `${lines.join('\n')}\n`);
    }

    const committed = readFileSync(FIXTURE, 'utf8').trim().split('\n');
    const parsed = committed.map((line) => parseCopilotEvent(line));

    expect(parsed).toEqual(EXAMPLES);
    // Every kind the union carries except `snapshot`, which only the streaming
    // surface produces and no second implementation would send.
    expect(new Set(parsed.map((event) => event?.kind))).toEqual(
      new Set(['token', 'citation', 'tool_call', 'tool_result', 'limit', 'error', 'done'])
    );
  });

  it('drops an unknown event kind rather than failing the stream', () => {
    // A second implementation may ship a new event before this build learns
    // about it. Losing one frame is a better outcome than ending a turn that
    // was otherwise going fine.
    expect(parseCopilotEvent('{"kind":"thinking","seq":9,"text":"hmm"}')).toBeNull();
    expect(parseCopilotEvent('not json at all')).toBeNull();
    expect(parseCopilotEvent('{"kind":"token"}')).toBeNull();
    expect(parseCopilotEvent('')).toBeNull();
  });
});
