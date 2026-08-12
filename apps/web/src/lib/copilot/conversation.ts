import type { CopilotEvent, PatchProposedEvent, ToolCallSummary } from './events';

/**
 * A turn as the reader sees it, assembled from the events as they arrive.
 *
 * Kept apart from React on purpose: reducing a stream of events into a message
 * is the part with rules worth testing - a tool call is replaced by its result
 * rather than listed twice, a proposal supersedes the previous one, a `done`
 * settles the turn - and none of those rules need a component to exercise them.
 */

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCall[];
  proposal: PatchProposedEvent | null;
  status: 'streaming' | 'complete' | 'limit' | 'cancelled' | 'error';
  /** Set when the turn stopped for a reason the reader should be told. */
  note: string | null;
  /** How many citations the run loop could not verify against its own ledger. */
  unverifiedCitations: number;
  lastSeq: number;
}

export interface ToolCall {
  callId: string;
  tool: string;
  summary: string;
  /** Null while the call is still running, which is what the spinner reads. */
  ok: boolean | null;
  durationMs: number | null;
}

export function startTurn(id: string, role: 'user' | 'assistant', content = ''): Turn {
  return {
    id,
    role,
    content,
    toolCalls: [],
    proposal: null,
    status: role === 'user' ? 'complete' : 'streaming',
    note: null,
    unverifiedCitations: 0,
    lastSeq: 0,
  };
}

export function applyEvent(turn: Turn, event: CopilotEvent): Turn {
  const next: Turn = { ...turn, lastSeq: Math.max(turn.lastSeq, event.seq) };

  switch (event.kind) {
    case 'token':
      return { ...next, content: next.content + event.text };

    case 'tool_call':
      return {
        ...next,
        toolCalls: [
          ...next.toolCalls,
          {
            callId: event.callId,
            tool: event.tool,
            summary: event.summary,
            ok: null,
            durationMs: null,
          },
        ],
      };

    case 'tool_result':
      return {
        ...next,
        toolCalls: next.toolCalls.map((call) =>
          call.callId === event.callId
            ? {
                ...call,
                summary: event.summary,
                ok: event.ok,
                durationMs: event.durationMs,
              }
            : call
        ),
      };

    case 'patch_proposed':
      // One card at a time. A turn that proposes twice has changed its mind, and
      // showing both would ask the user to accept an edit the model abandoned.
      return { ...next, proposal: event };

    case 'citation':
      return event.verified
        ? next
        : { ...next, unverifiedCitations: next.unverifiedCitations + 1 };

    case 'limit':
      return { ...next, note: event.message };

    case 'error':
      return { ...next, status: 'error', note: event.message };

    case 'done':
      return {
        ...next,
        status: event.finish === 'complete' ? 'complete' : event.finish,
        unverifiedCitations: event.unverifiedCitations,
      };

    case 'snapshot':
      // What a reconnecting client is handed: the server's record wins over
      // whatever this tab had, because it is the one that never dropped a frame.
      return {
        ...next,
        id: event.message.id,
        role: event.message.role,
        content: event.message.content,
        toolCalls: event.message.toolCalls.map((call: ToolCallSummary) => ({
          callId: call.callId,
          tool: call.tool,
          summary: call.summary,
          ok: call.ok,
          durationMs: call.durationMs,
        })),
        status: event.message.status,
        unverifiedCitations: event.message.unverifiedCitations,
        lastSeq: event.message.lastEventSeq,
      };

    default:
      return next;
  }
}
