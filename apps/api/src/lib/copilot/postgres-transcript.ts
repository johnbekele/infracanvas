import type pg from 'pg';

import { query, withTransaction } from '../db/client.js';
import { ExperimentNotFoundError } from './errors.js';
import type { CitationRecord, CopilotMessage, ToolCallSummary } from './events.js';
import type { CopilotScope } from './store.js';
import {
  TurnAlreadyStreamingError,
  type ConversationRecord,
  type MessagePatch,
  type TranscriptStore,
} from './transcript.js';

/**
 * `TranscriptStore` over `copilot_conversations` and `copilot_messages`.
 *
 * The two properties the port argues for are both the database's here rather
 * than this file's:
 *
 * - One streaming turn per conversation is `copilot_messages_streaming_idx`, a
 *   partial unique index. A check performed here would be a read followed by a
 *   write, and it would lose the race it exists for -- two tabs, or a retry
 *   arriving while the first request is still opening its turn.
 * - Sequence numbers are allocated under the conversation row's lock, so two
 *   concurrent appends cannot choose the same number.
 */

interface ConversationRow {
  id: string;
  experiment_id: string;
  user_id: string;
  created_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: CopilotMessage['role'];
  content: string;
  tool_calls: ToolCallSummary[];
  citations: CitationRecord[];
  proposal_id: string | null;
  status: CopilotMessage['status'];
  last_event_seq: number;
  input_tokens: number;
  output_tokens: number;
  unverified_citations: number;
  error_code: string | null;
  created_at: Date;
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    userId: row.user_id,
    createdAt: row.created_at.toISOString(),
  };
}

function toMessage(row: MessageRow): CopilotMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls,
    citations: row.citations,
    proposalId: row.proposal_id,
    status: row.status,
    lastEventSeq: row.last_event_seq,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    unverifiedCitations: row.unverified_citations,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres 23505: unique violation, raised here by the one-streaming-turn index. */
function isStreamingConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'copilot_messages_streaming_idx'
  );
}

/**
 * The pool, or a client already inside a transaction.
 *
 * Declared as the one call this module makes rather than as `Pick<PoolClient,
 * 'query'>`, so that the pool helper and a transaction client are the same type
 * here: `pg`'s own signature is a set of overloads, and a union of it with
 * anything else is not callable.
 */
interface Executor {
  query<T extends pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[]
  ): Promise<pg.QueryResult<T>>;
}

/**
 * The conversation of this experiment, created on first use.
 *
 * `ON CONFLICT DO NOTHING` rather than a read followed by an insert: two turns
 * opened at once would otherwise both find nothing and both insert. The insert
 * selects from `experiments`, so the scope is the same predicate the read uses
 * and no caller can start a conversation about an experiment it cannot see.
 *
 * `client` is the transaction `append` runs in, so the row it locks is the row it
 * numbers the message against.
 */
async function ensureConversation(
  scope: CopilotScope,
  client?: Executor
): Promise<ConversationRecord> {
  if (!UUID_PATTERN.test(scope.experimentId)) {
    throw new ExperimentNotFoundError(scope.experimentId);
  }

  const existing = await readConversation(scope, client);
  if (existing !== null) return existing;

  const run: Executor = client ?? { query };
  const created = await run.query<ConversationRow>(
    `INSERT INTO copilot_conversations (experiment_id, user_id)
     SELECT e.id, e.user_id FROM experiments e WHERE e.id = $1 AND e.user_id = $2
     ON CONFLICT (experiment_id) DO NOTHING
     RETURNING *`,
    [scope.experimentId, scope.userId]
  );
  if (created.rows[0]) return toConversation(created.rows[0]);

  // Either the experiment is not this user's, or another transaction inserted
  // the conversation between the read and the insert. The re-read separates
  // them, and answers the first the way every other scoped miss is answered.
  const raced = await readConversation(scope, client);
  if (raced === null) throw new ExperimentNotFoundError(scope.experimentId);
  return raced;
}

/**
 * The row is locked only when there is a transaction to hold the lock in;
 * outside one it would be released as the statement ended and mean nothing.
 */
async function readConversation(
  scope: CopilotScope,
  client?: Executor
): Promise<ConversationRecord | null> {
  const run: Executor = client ?? { query };
  const result = await run.query<ConversationRow>(
    `SELECT c.* FROM copilot_conversations c
       JOIN experiments e ON e.id = c.experiment_id
      WHERE c.experiment_id = $1 AND e.user_id = $2
      ${client === undefined ? '' : 'FOR UPDATE OF c'}`,
    [scope.experimentId, scope.userId]
  );
  return result.rows[0] ? toConversation(result.rows[0]) : null;
}

export class PostgresTranscriptStore implements TranscriptStore {
  async conversation(scope: CopilotScope): Promise<ConversationRecord> {
    return ensureConversation(scope);
  }

  async messages(scope: CopilotScope): Promise<CopilotMessage[]> {
    const conversation = await ensureConversation(scope);
    const result = await query<MessageRow>(
      'SELECT * FROM copilot_messages WHERE conversation_id = $1 ORDER BY seq ASC',
      [conversation.id]
    );
    return result.rows.map(toMessage);
  }

  /**
   * One message of this conversation, or null.
   *
   * The conversation is joined rather than looked up first, so the experiment and
   * the user are in the same WHERE clause as the message id: a message is as
   * private as the architecture its conversation is about.
   */
  async message(scope: CopilotScope, messageId: string): Promise<CopilotMessage | null> {
    if (!UUID_PATTERN.test(scope.experimentId) || !UUID_PATTERN.test(messageId)) return null;

    const result = await query<MessageRow>(
      `SELECT m.* FROM copilot_messages m
         JOIN copilot_conversations c ON c.id = m.conversation_id
         JOIN experiments e ON e.id = c.experiment_id
        WHERE m.id = $1 AND c.experiment_id = $2 AND e.user_id = $3`,
      [messageId, scope.experimentId, scope.userId]
    );
    return result.rows[0] ? toMessage(result.rows[0]) : null;
  }

  /**
   * Append a message, numbering it here rather than trusting a caller.
   *
   * The conversation row is locked for the transaction, which serialises two
   * appends: the second reads the sequence number the first installed instead of
   * computing the same one and losing to `UNIQUE (conversation_id, seq)` with an
   * error no caller could interpret.
   */
  async append(
    scope: CopilotScope,
    message: Pick<CopilotMessage, 'role' | 'content' | 'status'>
  ): Promise<CopilotMessage> {
    return withTransaction(async (client) => {
      const conversation = await ensureConversation(scope, client);

      try {
        const result = await client.query<MessageRow>(
          `INSERT INTO copilot_messages (conversation_id, seq, role, content, status)
           SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4::copilot_message_status
             FROM copilot_messages WHERE conversation_id = $1
           RETURNING *`,
          [conversation.id, message.role, message.content, message.status]
        );

        const row = result.rows[0];
        if (!row) throw new Error('Failed to append a copilot message');
        return toMessage(row);
      } catch (error) {
        // Translated rather than surfaced raw, so the route can answer 409
        // without knowing Postgres error codes.
        if (isStreamingConflict(error)) throw new TurnAlreadyStreamingError();
        throw error;
      }
    });
  }

  /**
   * Write part of a turn.
   *
   * One statement, because this runs several times a second while tokens
   * arrive. Every field is optional and absent means "leave it alone", which for
   * the two nullable columns cannot be expressed with COALESCE: setting
   * `proposalId` back to null is a real edit and has to be distinguishable from
   * not mentioning it.
   */
  async update(
    scope: CopilotScope,
    messageId: string,
    patch: MessagePatch
  ): Promise<CopilotMessage> {
    if (!UUID_PATTERN.test(scope.experimentId) || !UUID_PATTERN.test(messageId)) {
      throw new Error(`No message ${messageId}`);
    }

    const result = await query<MessageRow>(
      `UPDATE copilot_messages m
          SET content        = COALESCE($4, m.content),
              tool_calls     = COALESCE($5::jsonb, m.tool_calls),
              citations      = COALESCE($6::jsonb, m.citations),
              status         = COALESCE($7::copilot_message_status, m.status),
              last_event_seq = COALESCE($8::integer, m.last_event_seq),
              input_tokens   = COALESCE($9::integer, m.input_tokens),
              output_tokens  = COALESCE($10::integer, m.output_tokens),
              unverified_citations = COALESCE($11::integer, m.unverified_citations),
              proposal_id    = CASE WHEN $12::boolean THEN $13::uuid ELSE m.proposal_id END,
              error_code     = CASE WHEN $14::boolean THEN $15 ELSE m.error_code END
        WHERE m.id = $1
          AND m.conversation_id = (
                SELECT c.id FROM copilot_conversations c
                  JOIN experiments e ON e.id = c.experiment_id
                 WHERE c.experiment_id = $2 AND e.user_id = $3
              )
        RETURNING *`,
      [
        messageId,
        scope.experimentId,
        scope.userId,
        patch.content ?? null,
        patch.toolCalls === undefined ? null : JSON.stringify(patch.toolCalls),
        patch.citations === undefined ? null : JSON.stringify(patch.citations),
        patch.status ?? null,
        patch.lastEventSeq ?? null,
        patch.inputTokens ?? null,
        patch.outputTokens ?? null,
        patch.unverifiedCitations ?? null,
        patch.proposalId !== undefined,
        patch.proposalId ?? null,
        patch.errorCode !== undefined,
        patch.errorCode ?? null,
      ]
    );

    const row = result.rows[0];
    // The same failure as the in-memory adapter's, so a caller that has to
    // handle it does not have to handle two shapes of it.
    if (!row) throw new Error(`No message ${messageId}`);
    return toMessage(row);
  }
}
