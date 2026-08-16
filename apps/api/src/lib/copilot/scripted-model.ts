import type { ChatChunk, ChatModel, ChatRequest } from './chat-model.js';

/**
 * A model that plays a script.
 *
 * Every turn in the suite runs against one of these, because a copilot that can
 * only be exercised against a live provider is a copilot nobody will change,
 * and because the behaviours worth testing - a turn that loops, a turn that
 * cites a file it never read, a turn cancelled halfway - are precisely the ones
 * a real model cannot be asked to perform on demand.
 *
 * It is shipped rather than kept in a test file so the route tests and the run
 * loop tests drive the same fake.
 */

export type ScriptedRound = ChatChunk[];

export interface ScriptedModel extends ChatModel {
  /** One entry per model turn, in order. */
  readonly requests: ChatRequest[];
}

export function scriptedModel(rounds: ScriptedRound[]): ScriptedModel {
  const requests: ChatRequest[] = [];
  let round = 0;

  return {
    requests,
    async *stream(request, signal) {
      requests.push(structuredClone(request));
      const chunks = rounds[round] ?? [];
      round += 1;

      for (const chunk of chunks) {
        if (signal.aborted) return;
        // A tick between chunks, so a cancellation between tokens is a state
        // the tests can actually reach.
        await new Promise((resolve) => setTimeout(resolve, 0));
        yield chunk;
      }
    },
  };
}

export function text(...parts: string[]): ChatChunk[] {
  return parts.map((part) => ({ kind: 'text', text: part }));
}

export function toolCall(callId: string, name: string, args: unknown): ChatChunk {
  return { kind: 'tool_call', callId, name, arguments: JSON.stringify(args) };
}
