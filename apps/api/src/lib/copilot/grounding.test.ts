import { describe, expect, it } from 'vitest';

import { GroundedStream, GroundingLedger, MAX_MARKER_CHARS } from './grounding.js';

function drain(stream: GroundedStream, chunks: string[]) {
  return [...chunks.flatMap((chunk) => stream.push(chunk)), ...stream.flush()];
}

describe('the grounding ledger', () => {
  it('verifies a file citation inside a range a tool returned', () => {
    const ledger = new GroundingLedger();
    ledger.recordSpan('apps/api/src/lib/db/llm-credentials.ts', 141, 156);

    expect(ledger.check('file', 'apps/api/src/lib/db/llm-credentials.ts#L145-L150')).toEqual({
      verified: true,
      reason: null,
    });
  });

  it('refuses a wider range than anyone read, because that is a claim of its own', () => {
    const ledger = new GroundingLedger();
    ledger.recordSpan('apps/api/src/index.ts', 10, 20);

    const check = ledger.check('file', 'apps/api/src/index.ts#L1-L400');

    expect(check.verified).toBe(false);
    expect(check.reason).toContain('outside the range');
  });

  it('refuses a file no tool returned at all', () => {
    expect(new GroundingLedger().check('file', 'src/made-up.ts#L1-L2').verified).toBe(false);
  });

  it('verifies a sku and a prediction only when they were produced this turn', () => {
    const ledger = new GroundingLedger();
    ledger.recordSku('rds-us-east-1.json');
    ledger.recordPrediction('abc123');

    expect(ledger.check('sku', 'rds-us-east-1.json').verified).toBe(true);
    expect(ledger.check('sku', 'invented').verified).toBe(false);
    expect(ledger.check('prediction', 'abc123').verified).toBe(true);
    expect(ledger.check('prediction', 'def456').verified).toBe(false);
  });
});

describe('the grounded stream', () => {
  it('passes text through and turns a marker into a citation', () => {
    const ledger = new GroundingLedger();
    ledger.recordPrediction('abc123');
    const stream = new GroundedStream(ledger);

    const out = drain(stream, ['Multi-AZ costs $15.44 more ', '[prediction:abc123]', ' a month.']);

    expect(out).toEqual([
      { kind: 'text', text: 'Multi-AZ costs $15.44 more ' },
      { kind: 'citation', scheme: 'prediction', target: 'abc123', verified: true, reason: null },
      { kind: 'text', text: ' a month.' },
    ]);
  });

  it('emits an unsupported citation as unsupported rather than dropping the text', () => {
    const stream = new GroundedStream(new GroundingLedger());

    const out = drain(stream, ['The file says so [file:src/never-read.ts#L1-L9] here.']);

    expect(out[1]).toMatchObject({ kind: 'citation', verified: false });
    expect(out.map((entry) => entry.text).join('')).toContain('here.');
  });

  it('reassembles a marker split across chunks', () => {
    const ledger = new GroundingLedger();
    ledger.recordSku('ABC123');
    const stream = new GroundedStream(ledger);

    const out = drain(stream, ['costs [sk', 'u:ABC', '123] a month']);

    expect(out.filter((entry) => entry.kind === 'citation')).toEqual([
      { kind: 'citation', scheme: 'sku', target: 'ABC123', verified: true, reason: null },
    ]);
  });

  it('passes an ordinary bracket through untouched', () => {
    const stream = new GroundedStream(new GroundingLedger());

    const out = drain(stream, ['const list = [1, 2, 3];']);

    expect(out.map((entry) => entry.text).join('')).toBe('const list = [1, 2, 3];');
  });

  it('flushes an unclosed bracket as text rather than holding the stream', () => {
    const stream = new GroundedStream(new GroundingLedger());
    const long = `[${'x'.repeat(MAX_MARKER_CHARS + 10)}`;

    const out = drain(stream, [long, ' and then more text']);

    // Bounded by the marker length, so a code sample with a stray bracket
    // cannot deadlock a turn.
    expect(out.map((entry) => entry.text).join('')).toBe(`${long} and then more text`);
  });
});
