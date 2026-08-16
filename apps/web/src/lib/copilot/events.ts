import type { PatchPreview } from '@infracanvas/core';

/**
 * The events one copilot turn emits, mirrored from `apps/api/src/lib/copilot/events.ts`.
 *
 * Duplicated rather than imported because the browser bundle cannot reach into
 * the server package, and the pair is pinned by `fixtures/copilot/events.example.jsonl`
 * on both sides rather than by a shared type nobody can import.
 *
 * `seq` is per message and strictly increasing, which is what makes resuming a
 * dropped connection possible: the client says how far it got and is sent the
 * rest.
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

export interface PatchProposedEvent {
  kind: 'patch_proposed';
  seq: number;
  proposalId: string;
  patchDigest: string;
  summary: string;
  touchedNodeIds: string[];
  preview: PatchPreview;
}

export type CopilotEvent =
  | { kind: 'token'; seq: number; text: string }
  | {
      kind: 'citation';
      seq: number;
      scheme: CitationScheme;
      target: string;
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
  | PatchProposedEvent
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
 * One event, or nothing.
 *
 * The wire format splits an event across the SSE frame: the kind is the `event`
 * field, the sequence is the tail of the `id` field, and `data` carries only
 * what is left. So this takes the three separately and puts the event back
 * together, rather than parsing a self-describing JSON object.
 *
 * An unrecognised kind is dropped rather than thrown, because the server may
 * ship a new event before this bundle learns about it, and losing one frame is
 * a better outcome for the reader than ending a turn that was going fine.
 */
export function parseCopilotEvent(kind: string, seq: number, data: string): CopilotEvent | null {
  if (!KINDS.has(kind) || !Number.isInteger(seq)) return null;

  const trimmed = data.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  return { ...(parsed as object), kind, seq } as CopilotEvent;
}
