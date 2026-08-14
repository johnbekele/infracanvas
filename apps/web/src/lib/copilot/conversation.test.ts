import { describe, expect, it } from 'vitest';
import type { PatchPreview } from '@infracanvas/core';

import { applyEvent, startTurn, type Turn } from './conversation';
import type { CopilotEvent } from './events';

function replay(events: CopilotEvent[]): Turn {
  return events.reduce(applyEvent, startTurn('msg_1', 'assistant'));
}

const preview = { patchDigest: 'sha256:a' } as unknown as PatchPreview;

function proposed(proposalId: string, seq: number): CopilotEvent {
  return {
    kind: 'patch_proposed',
    seq,
    proposalId,
    patchDigest: 'sha256:a',
    summary: 'Turn on Multi-AZ',
    touchedNodeIds: ['db'],
    preview,
  };
}

describe('assembling a turn from its events', () => {
  it('joins tokens in the order they arrive', () => {
    const turn = replay([
      { kind: 'token', seq: 1, text: 'Multi' },
      { kind: 'token', seq: 2, text: '-AZ' },
    ]);

    expect(turn.content).toBe('Multi-AZ');
  });

  it('replaces a running tool call with its result rather than listing it twice', () => {
    const turn = replay([
      { kind: 'tool_call', seq: 1, callId: 'c1', tool: 'price_architecture', summary: 'Pricing' },
      {
        kind: 'tool_result',
        seq: 2,
        callId: 'c1',
        tool: 'price_architecture',
        ok: true,
        summary: '$412 a month',
        durationMs: 120,
      },
    ]);

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({ ok: true, summary: '$412 a month', durationMs: 120 });
  });

  it('leaves a call in flight until its result arrives', () => {
    const turn = replay([
      { kind: 'tool_call', seq: 1, callId: 'c1', tool: 'price_architecture', summary: 'Pricing' },
    ]);

    expect(turn.toolCalls[0]?.ok).toBeNull();
  });

  it('keeps only the newest proposal, because a turn that proposes twice changed its mind', () => {
    const turn = replay([proposed('p1', 1), proposed('p2', 2)]);

    expect(turn.proposal?.proposalId).toBe('p2');
  });

  it('counts citations the run loop could not verify', () => {
    const turn = replay([
      {
        kind: 'citation',
        seq: 1,
        scheme: 'file',
        target: 'api/main.py#L1',
        verified: true,
        reason: null,
      },
      {
        kind: 'citation',
        seq: 2,
        scheme: 'sku',
        target: 'db.t3.micro',
        verified: false,
        reason: 'no such SKU in the snapshot',
      },
    ]);

    expect(turn.unverifiedCitations).toBe(1);
  });

  it('settles on done, and trusts its count over the one it accumulated', () => {
    const turn = replay([
      { kind: 'token', seq: 1, text: 'Right' },
      {
        kind: 'done',
        seq: 2,
        finish: 'complete',
        inputTokens: 10,
        outputTokens: 2,
        toolCalls: 0,
        unverifiedCitations: 0,
      },
    ]);

    expect(turn.status).toBe('complete');
  });

  it('carries a limit through as something to tell the reader', () => {
    const turn = replay([
      { kind: 'limit', seq: 1, limit: 'tool_calls', message: 'Stopped after eight tool calls.' },
    ]);

    expect(turn.note).toBe('Stopped after eight tool calls.');
    // Not an error: the turn ran out of room, and what it did say still stands.
    expect(turn.status).toBe('streaming');
  });

  it('ends in error when the turn failed', () => {
    const turn = replay([
      { kind: 'error', seq: 1, code: 'provider_error', message: 'The model refused.' },
    ]);

    expect(turn).toMatchObject({ status: 'error', note: 'The model refused.' });
  });

  it('lets a snapshot overwrite what this tab thought, since it never dropped a frame', () => {
    const turn = replay([
      { kind: 'token', seq: 1, text: 'half an answer' },
      {
        kind: 'snapshot',
        seq: 9,
        message: {
          id: 'msg_1',
          conversationId: 'c',
          seq: 2,
          role: 'assistant',
          content: 'the whole answer',
          toolCalls: [
            { callId: 'c1', tool: 'price_architecture', summary: 'done', ok: true, durationMs: 5 },
          ],
          citations: [],
          proposalId: null,
          status: 'complete',
          lastEventSeq: 9,
          inputTokens: 3,
          outputTokens: 4,
          unverifiedCitations: 0,
          errorCode: null,
          createdAt: '2026-08-12T00:00:00.000Z',
        },
      },
    ]);

    expect(turn.content).toBe('the whole answer');
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.lastSeq).toBe(9);
  });

  it('tracks the highest sequence seen, which is what a reconnect resumes from', () => {
    const turn = replay([
      { kind: 'token', seq: 1, text: 'a' },
      { kind: 'token', seq: 4, text: 'b' },
    ]);

    expect(turn.lastSeq).toBe(4);
  });
});
