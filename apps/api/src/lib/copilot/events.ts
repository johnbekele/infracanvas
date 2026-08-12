import type { PatchPreview } from '@infracanvas/core';

/**
 * Everything a turn can say.
 *
 * `040-conversation-run-loop.md` defines this union for a Python brain emitting
 * NDJSON and `050-copilot-sse-endpoint.md` mirrors it in TypeScript. The
 * copilot is TypeScript, so there is one definition rather than two, and it is
 * this one: the field names follow the API's mirror, which is what a browser
 * already parses, and `fixtures/copilot/events.example.jsonl` pins the shape so
 * that a second implementation in another language can be checked against it
 * line by line.
 *
 * `seq` is per message and strictly increasing. It is what an SSE frame id is
 * built from, and therefore what makes resumption possible at all.
 */

export type CitationScheme = 'file' | 'sku' | 'prediction';

export type LimitKind = 'tool_calls' | 'proposals' | 'wall_clock' | 'tool_timeout';

export type ErrorCode = 'provider_error' | 'preview_unavailable' | 'cancelled' | 'internal';

export type FinishReason = 'complete' | 'limit' | 'cancelled' | 'error';

export interface ToolCallSummary {
  callId: string;
  tool: string;
  summary: string;
  ok: boolean;
  durationMs: number;
}

export interface CitationRecord {
  scheme: CitationScheme;
  target: string;
  verified: boolean;
  reason: string | null;
}

/** The persisted form of a turn, and what a resuming client is handed. */
export interface CopilotMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallSummary[];
  citations: CitationRecord[];
  proposalId: string | null;
  status: 'streaming' | 'complete' | 'limit' | 'cancelled' | 'error';
  lastEventSeq: number;
  inputTokens: number;
  outputTokens: number;
  unverifiedCitations: number;
  errorCode: string | null;
  createdAt: string;
}

export type CopilotEvent =
  | { kind: 'token'; seq: number; text: string }
  | {
      kind: 'citation';
      seq: number;
      scheme: CitationScheme;
      target: string;
      /** False when the ledger has no record of this span, SKU or prediction. */
      verified: boolean;
      reason: string | null;
    }
  | { kind: 'tool_call'; seq: number; callId: string; tool: string; summary: string }
  | {
      kind: 'tool_result';
      seq: number;
      callId: string;
      tool: string;
      ok: boolean;
      summary: string;
      durationMs: number;
    }
  | {
      kind: 'patch_proposed';
      seq: number;
      proposalId: string;
      patchDigest: string;
      summary: string;
      touchedNodeIds: string[];
      preview: PatchPreview;
    }
  | { kind: 'limit'; seq: number; limit: LimitKind; message: string }
  | { kind: 'error'; seq: number; code: ErrorCode; message: string }
  | {
      kind: 'done';
      seq: number;
      finish: FinishReason;
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      unverifiedCitations: number;
    }
  /** Produced only by the streaming surface, for a client that reconnected. */
  | { kind: 'snapshot'; seq: number; message: CopilotMessage };

const KINDS = new Set([
  'token',
  'citation',
  'tool_call',
  'tool_result',
  'patch_proposed',
  'limit',
  'error',
  'done',
  'snapshot',
]);

/**
 * One line of a turn, or nothing.
 *
 * Returns null for a kind this build does not know rather than throwing: a
 * second implementation of the run loop may ship a new event before this
 * process learns about it, and dropping one frame is a better outcome for the
 * user than ending a turn that was otherwise going fine.
 */
export function parseCopilotEvent(line: string): CopilotEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.kind !== 'string' || !KINDS.has(candidate.kind)) return null;
  if (typeof candidate.seq !== 'number' || !Number.isInteger(candidate.seq)) return null;

  return candidate as CopilotEvent;
}
