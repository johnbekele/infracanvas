import { randomUUID } from 'node:crypto';

import type { CitationRecord, CopilotMessage, ToolCallSummary } from './events.js';
import type { CopilotScope } from './store.js';

/**
 * The transcript: one conversation per experiment, and its messages in order.
 *
 * A port with an in-memory adapter, for the same reason `CopilotStore` is one:
 * `050-copilot-sse-endpoint.md` puts these rows in Postgres beside
 * `experiments`, and that table belongs to #27, which is still open. The
 * behaviour the spec argues for lives in the interface - one streaming turn at
 * a time, sequence numbers allocated by the store rather than by a caller, and
 * incremental writes during a turn - so the Postgres adapter is a translation
 * of these five methods rather than a second design.
 */

export interface ConversationRecord {
  id: string;
  experimentId: string;
  userId: string;
  createdAt: string;
}

export interface MessagePatch {
  content?: string;
  toolCalls?: ToolCallSummary[];
  citations?: CitationRecord[];
  proposalId?: string | null;
  status?: CopilotMessage['status'];
  lastEventSeq?: number;
  inputTokens?: number;
  outputTokens?: number;
  unverifiedCitations?: number;
  errorCode?: string | null;
}

/** Raised instead of a 500 when a second turn is opened against one conversation. */
export class TurnAlreadyStreamingError extends Error {
  constructor() {
    super('A turn is already streaming in this conversation');
    this.name = 'TurnAlreadyStreamingError';
  }
}

export interface TranscriptStore {
  conversation(scope: CopilotScope): Promise<ConversationRecord>;
  messages(scope: CopilotScope): Promise<CopilotMessage[]>;
  message(scope: CopilotScope, messageId: string): Promise<CopilotMessage | null>;
  /** Appends a message. Throws `TurnAlreadyStreamingError` for a second streaming one. */
  append(
    scope: CopilotScope,
    message: Pick<CopilotMessage, 'role' | 'content' | 'status'>
  ): Promise<CopilotMessage>;
  update(scope: CopilotScope, messageId: string, patch: MessagePatch): Promise<CopilotMessage>;
}

export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly byConversation = new Map<string, CopilotMessage[]>();

  async conversation(scope: CopilotScope): Promise<ConversationRecord> {
    const key = `${scope.userId}:${scope.experimentId}`;
    const existing = this.conversations.get(key);
    if (existing !== undefined) return existing;

    const created: ConversationRecord = {
      id: randomUUID(),
      experimentId: scope.experimentId,
      userId: scope.userId,
      createdAt: new Date().toISOString(),
    };
    this.conversations.set(key, created);
    this.byConversation.set(created.id, []);
    return created;
  }

  async messages(scope: CopilotScope): Promise<CopilotMessage[]> {
    const conversation = await this.conversation(scope);
    return [...(this.byConversation.get(conversation.id) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async message(scope: CopilotScope, messageId: string): Promise<CopilotMessage | null> {
    return (await this.messages(scope)).find((entry) => entry.id === messageId) ?? null;
  }

  async append(
    scope: CopilotScope,
    message: Pick<CopilotMessage, 'role' | 'content' | 'status'>
  ): Promise<CopilotMessage> {
    const conversation = await this.conversation(scope);
    const existing = this.byConversation.get(conversation.id) ?? [];

    // One turn at a time. Two turns against one architecture would each propose
    // patches against a document the other is about to change, and the failure
    // would surface much later as a stale proposal nobody could explain.
    if (message.status === 'streaming' && existing.some((entry) => entry.status === 'streaming')) {
      throw new TurnAlreadyStreamingError();
    }

    const record: CopilotMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      // Allocated here rather than by the caller, so two concurrent appends
      // cannot choose the same number.
      seq: existing.reduce((highest, entry) => Math.max(highest, entry.seq), 0) + 1,
      role: message.role,
      content: message.content,
      toolCalls: [],
      citations: [],
      proposalId: null,
      status: message.status,
      lastEventSeq: 0,
      inputTokens: 0,
      outputTokens: 0,
      unverifiedCitations: 0,
      errorCode: null,
      createdAt: new Date().toISOString(),
    };

    existing.push(record);
    this.byConversation.set(conversation.id, existing);
    return record;
  }

  async update(
    scope: CopilotScope,
    messageId: string,
    patch: MessagePatch
  ): Promise<CopilotMessage> {
    const conversation = await this.conversation(scope);
    const messages = this.byConversation.get(conversation.id) ?? [];
    const index = messages.findIndex((entry) => entry.id === messageId);
    if (index === -1) throw new Error(`No message ${messageId}`);

    messages[index] = { ...messages[index], ...patch };
    return messages[index];
  }
}
