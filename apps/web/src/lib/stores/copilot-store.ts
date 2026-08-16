import { create } from 'zustand';

import type { CopilotEvent, CopilotMessage, ProposalView, ToolCallView } from '@/lib/copilot/types';

export type { CopilotMessage, ProposalView } from '@/lib/copilot/types';

export interface CopilotState {
  isOpen: boolean;
  messages: CopilotMessage[];
  /** IR node ids the pending proposal touches. Empty when nothing is pending. */
  highlightedNodeIds: string[];
  streamingMessageId: string | null;
  refusal: { code: string; message: string } | null;

  open(): void;
  close(): void;
  loadTranscript(messages: CopilotMessage[]): void;
  /** Applies one event. The only way a message changes. */
  applyEvent(event: CopilotEvent): void;
  /** Replaces the streaming message wholesale, for a resume snapshot. */
  applySnapshot(message: CopilotMessage): void;
  decideProposal(proposalId: string, decision: 'accepted' | 'rejected'): void;
  setRefusal(refusal: { code: string; message: string } | null): void;
  reset(): void;
}

interface TokenBuffer {
  messageId: string;
  chunks: string[];
  handle: ReturnType<typeof scheduleFrame> | null;
}

const tokenBuffer: TokenBuffer = {
  messageId: '',
  chunks: [],
  handle: null,
};

function scheduleFrame(cb: () => void): { cancel: () => void } {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb());
    return { cancel: () => cancelAnimationFrame(id) };
  }
  const id = setTimeout(cb, 0);
  return { cancel: () => clearTimeout(id) };
}

function flushTokenBuffer(
  set: (partial: Partial<CopilotState> | ((s: CopilotState) => Partial<CopilotState>)) => void,
  get: () => CopilotState
): void {
  tokenBuffer.handle = null;
  if (tokenBuffer.chunks.length === 0) return;
  const text = tokenBuffer.chunks.join('');
  tokenBuffer.chunks = [];
  const messageId = tokenBuffer.messageId;
  if (!messageId) return;

  const messages = get().messages.map((m) =>
    m.id === messageId ? { ...m, content: m.content + text } : m
  );
  set({ messages });
}

function pendingHighlights(messages: CopilotMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const proposal = messages[i]?.proposal;
    if (proposal?.decision === 'pending') {
      return [...proposal.touchedNodeIds];
    }
  }
  return [];
}

function streamingIdOf(messages: CopilotMessage[]): string | null {
  const open = messages.find((m) => m.status === 'streaming');
  return open?.id ?? null;
}

const initial = {
  isOpen: false,
  messages: [] as CopilotMessage[],
  highlightedNodeIds: [] as string[],
  streamingMessageId: null as string | null,
  refusal: null as { code: string; message: string } | null,
};

export const useCopilotStore = create<CopilotState>((set, get) => ({
  ...initial,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),

  loadTranscript: (messages) => {
    flushTokenBuffer(set, get);
    set({
      messages,
      streamingMessageId: streamingIdOf(messages),
      highlightedNodeIds: pendingHighlights(messages),
      refusal: null,
    });
  },

  applySnapshot: (message) => {
    flushTokenBuffer(set, get);
    const existing = get().messages;
    const idx = existing.findIndex((m) => m.id === message.id);
    const messages =
      idx === -1 ? [...existing, message] : existing.map((m, i) => (i === idx ? message : m));
    set({
      messages,
      streamingMessageId: message.status === 'streaming' ? message.id : streamingIdOf(messages),
      highlightedNodeIds: pendingHighlights(messages),
    });
  },

  applyEvent: (event) => {
    if (event.kind === 'snapshot') {
      get().applySnapshot(event.message);
      return;
    }

    if (event.kind === 'token') {
      const messageId = get().streamingMessageId;
      if (!messageId) return;
      tokenBuffer.messageId = messageId;
      tokenBuffer.chunks.push(event.text);
      if (tokenBuffer.handle === null) {
        tokenBuffer.handle = scheduleFrame(() => flushTokenBuffer(set, get));
      }
      return;
    }

    // Non-token events must see tokens already applied, in order.
    flushTokenBuffer(set, get);

    const state = get();
    const messageId = state.streamingMessageId;
    if (!messageId && event.kind !== 'done') {
      return;
    }

    const messages = state.messages.map((message) => {
      if (messageId && message.id !== messageId) return message;
      return reduceMessage(message, event);
    });

    let streamingMessageId = state.streamingMessageId;
    let highlightedNodeIds = state.highlightedNodeIds;

    if (event.kind === 'done') {
      streamingMessageId = null;
    }
    if (event.kind === 'patch_proposed') {
      highlightedNodeIds = [...event.touchedNodeIds];
    }

    set({
      messages,
      streamingMessageId,
      highlightedNodeIds,
    });
  },

  decideProposal: (proposalId, decision) => {
    flushTokenBuffer(set, get);
    const messages = get().messages.map((message) => {
      if (!message.proposal || message.proposal.proposalId !== proposalId) {
        return message;
      }
      if (message.proposal.decision !== 'pending') {
        return message;
      }
      return {
        ...message,
        proposal: { ...message.proposal, decision },
      };
    });
    set({
      messages,
      highlightedNodeIds: decision === 'rejected' ? [] : pendingHighlights(messages),
    });
  },

  setRefusal: (refusal) => set({ refusal }),

  reset: () => {
    if (tokenBuffer.handle) {
      tokenBuffer.handle.cancel();
      tokenBuffer.handle = null;
    }
    tokenBuffer.chunks = [];
    tokenBuffer.messageId = '';
    set({ ...initial });
  },
}));

function reduceMessage(message: CopilotMessage, event: CopilotEvent): CopilotMessage {
  switch (event.kind) {
    case 'token':
      return { ...message, content: message.content + event.text };
    case 'citation': {
      const citations = [
        ...message.citations,
        {
          scheme: event.scheme,
          target: event.target,
          verified: event.verified,
          reason: event.reason,
        },
      ];
      return {
        ...message,
        citations,
        unverifiedCitations: citations.filter((c) => !c.verified).length,
      };
    }
    case 'tool_call': {
      const call: ToolCallView = {
        callId: event.callId,
        tool: event.tool,
        summary: event.summary,
      };
      return { ...message, toolCalls: [...message.toolCalls, call] };
    }
    case 'tool_result': {
      const toolCalls = message.toolCalls.map((call) =>
        call.callId === event.callId
          ? {
              ...call,
              summary: event.summary || call.summary,
              ok: event.ok,
              durationMs: event.durationMs,
            }
          : call
      );
      return { ...message, toolCalls };
    }
    case 'patch_proposed': {
      const proposal: ProposalView = {
        proposalId: event.proposalId,
        summary: event.summary,
        operations: event.operations?.length ? event.operations : [event.summary],
        touchedNodeIds: event.touchedNodeIds,
        preview: event.preview,
        decision: 'pending',
      };
      return { ...message, proposal };
    }
    case 'limit':
      return { ...message, status: 'limit', content: message.content || event.message };
    case 'error':
      return { ...message, status: 'error' };
    case 'done':
      return {
        ...message,
        status: event.finish,
        unverifiedCitations: event.unverifiedCitations,
      };
    default:
      return message;
  }
}

/** Flush coalesced tokens immediately. Used by tests that drive the store without a frame loop. */
export function flushCopilotTokensForTests(): void {
  const set = useCopilotStore.setState.bind(useCopilotStore);
  const get = useCopilotStore.getState.bind(useCopilotStore);
  if (tokenBuffer.handle) {
    tokenBuffer.handle.cancel();
  }
  flushTokenBuffer(set, get);
}
