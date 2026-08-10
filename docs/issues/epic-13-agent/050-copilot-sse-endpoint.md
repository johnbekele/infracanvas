---
title: '[api] Copilot conversation persistence and a server-sent event stream per turn'
labels: tier:1, size:l, area:api, area:db, epic:13-agent
---

### Epic

#117

### Context

`services/brain` is not reachable from anywhere. It is absent from `docker-compose.yml`, no code in
`apps/api` mentions it, and it holds no session: `apps/api/src/middleware/auth.ts` and the Postgres
sessions from #47 are the only thing in the system that knows who a caller is. So the copilot needs a
public surface on the API, and that surface has to do three things the brain cannot: authenticate the
user, prove the experiment is theirs, and keep the transcript.

Letting the browser talk to the brain directly was considered and rejected. It would mean a second
authentication implementation, a second CORS surface, and a session store in Python, all so that one
process hop could be avoided on a request whose latency is dominated by a language model. Proxying also
puts persistence in the right place: the API is already the only writer of `experiments`, and the
transcript belongs beside it.

**Server-sent events, for the same reasons as #29.** The traffic is one-directional, SSE survives
proxies that mangle websocket upgrades, and the browser reconnects on its own. The one thing #29 does
not have to solve is that a turn starts with a POST -- there is a message body -- while `EventSource` is
GET-only and is the only thing that reconnects automatically. So the turn streams from the POST, read
with `fetch` and a `ReadableStream`, and resumption is a separate GET that replays what was persisted
and then attaches to the live turn. That split is why every event carries `id: <messageId>:<seq>` and
why the assistant message row records `last_event_seq`.

**Resumption replays a snapshot rather than a token history.** Persisting every token as a row so it
could be replayed in order would multiply write volume by the length of the reply for a case that
happens when a laptop lid closes. Instead the assembled text, the tool calls and the proposal are
written to the message row as the turn proceeds, and a reconnecting client receives one `snapshot`
event carrying that state before the live events resume. The client replaces its local message with the
snapshot, which also repairs a client that missed events it will never see again.

**One streaming turn per conversation, enforced by a partial unique index** rather than by application
code, in the same way `llm_credentials_one_default_idx` enforces one default credential. Two turns
against one architecture would each propose patches against a document the other is about to change, and
the failure would surface much later as a stale proposal nobody could explain.

**Rate limiting is per user, which the existing middleware cannot do.**
`apps/api/src/middleware/rate-limit.ts` builds every limiter on the library's default IP key, and its
own header comment explains why keying by hand is a bad idea: IPv6 clients need subnet bucketing. A turn
costs the user's own tokens and holds a connection for up to two minutes, so the meaningful bucket is
the session's user id, with the library's `ipKeyGenerator` as the fallback for a request that has no
session. That is a new `userLimiter` in the same module, not a new module, and the hourly ceiling is a
guard on this process rather than on spend -- spend is #99's monthly budget, which refuses with a 402.

Spec: `docs/DATABASE.md`

### Contract

```sql
-- db/migrations/<timestamp>_copilot_conversations.sql
-- One conversation per experiment. A second thread about the same architecture
-- would split the record of why it looks the way it does, which is the thing
-- this table exists to keep.
CREATE TABLE copilot_conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL UNIQUE REFERENCES experiments (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE copilot_message_role AS ENUM ('user', 'assistant');
CREATE TYPE copilot_message_status AS ENUM (
  'streaming', 'complete', 'limit', 'cancelled', 'error'
);

CREATE TABLE copilot_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES copilot_conversations (id) ON DELETE CASCADE,
  -- Monotonic within a conversation. Orders the transcript and is not a clock,
  -- because two messages can share a millisecond.
  seq             integer NOT NULL CHECK (seq > 0),
  role            copilot_message_role NOT NULL,
  content         text NOT NULL DEFAULT '',
  -- [{callId, tool, summary, ok, durationMs}], in call order. The summary is
  -- what the UI renders; arguments are deliberately not stored, because a tool
  -- argument can contain a whole patch and the proposal row already has it.
  tool_calls      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{scheme, target, verified, reason}] from the grounding filter.
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal_id     uuid REFERENCES copilot_patch_proposals (id) ON DELETE SET NULL,
  status          copilot_message_status NOT NULL DEFAULT 'streaming',
  -- Where a resuming client should pick up.
  last_event_seq  integer NOT NULL DEFAULT 0,
  input_tokens    integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  unverified_citations integer NOT NULL DEFAULT 0 CHECK (unverified_citations >= 0),
  -- Safe to show a user. Never a provider body.
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  -- A user message is never mid-flight, and only an assistant message can fail.
  CHECK (role = 'assistant' OR status = 'complete')
);

CREATE INDEX copilot_messages_conversation_idx
  ON copilot_messages (conversation_id, seq);

-- One turn at a time, as a constraint rather than as a check some code path can
-- skip.
CREATE UNIQUE INDEX copilot_messages_one_streaming_idx
  ON copilot_messages (conversation_id) WHERE status = 'streaming';

CREATE TRIGGER copilot_messages_set_updated_at
  BEFORE UPDATE ON copilot_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER copilot_conversations_set_updated_at
  BEFORE UPDATE ON copilot_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`seq` is allocated inside the inserting transaction as
`(SELECT coalesce(max(seq), 0) + 1 FROM copilot_messages WHERE conversation_id = $1)`; the unique
constraint turns a race into a failed insert, which is retried once. A sequence per conversation was
rejected because it would leave gaps on every rolled-back turn and the transcript is read in order.

Routes. The router mounts at `/experiments` in `apps/api/src/index.ts`, alongside
`/repositories` and `/settings`; the browser reaches it as `/api/experiments/...` because
`apps/web/src/lib/api/client.ts` prefixes `/api` for the Vite dev proxy and uses `VITE_API_URL`
otherwise. All four require a session and are scoped to the requesting user, and a miss is 404 rather
than 403.

| Route                                                        | Behaviour                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `GET /experiments/:id/copilot`                               | The transcript: messages in `seq` order with their proposals |
| `POST /experiments/:id/copilot/messages`                     | Records the user message, streams the assistant turn as SSE  |
| `GET /experiments/:id/copilot/messages/:messageId/events`    | Resumes a turn: `snapshot`, then live events                 |
| `POST /experiments/:id/copilot/proposals/:proposalId/accept` | Accepts and applies; returns the new IR and its digest       |
| `POST /experiments/:id/copilot/proposals/:proposalId/reject` | Marks the proposal rejected and changes nothing else         |

```typescript
// apps/api/src/lib/copilot/events.ts
/**
 * Mirrors the union in services/brain/src/brain/copilot/events.py, plus
 * `snapshot`, which only this process produces and the brain never sends.
 */
export type CopilotEvent =
  | { kind: 'token'; seq: number; text: string }
  | {
      kind: 'citation';
      seq: number;
      scheme: 'file' | 'sku' | 'prediction';
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
  | {
      kind: 'patch_proposed';
      seq: number;
      proposalId: string;
      patchDigest: string;
      summary: string;
      touchedNodeIds: string[];
      preview: PatchPreview;
    }
  | { kind: 'limit'; seq: number; limit: string; message: string }
  | { kind: 'error'; seq: number; code: string; message: string }
  | {
      kind: 'done';
      seq: number;
      finish: 'complete' | 'limit' | 'cancelled' | 'error';
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      unverifiedCitations: number;
    }
  | { kind: 'snapshot'; seq: number; message: CopilotMessage };

/** Returns null for a kind this build does not know, which is logged and dropped
 *  rather than failing the stream: the brain may ship a new event first. */
export function parseBrainEvent(line: string): CopilotEvent | null;
```

```typescript
// apps/api/src/lib/copilot/stream.ts
/** SSE framing, identical in both streaming routes so the client sees one format. */
export function writeEvent(res: Response, messageId: string, event: CopilotEvent): void;

/** A comment line every 15 seconds, matching the interval #29 established. */
export const KEEPALIVE_MS = 15_000;

/**
 * In-process fan-out from a running turn to a resuming reader. Single-instance,
 * for the same reason the rate limit store is: behind two instances a resume
 * that lands on the wrong process falls back to the snapshot and then polls the
 * message row until `status` leaves `streaming`. Correct, just less live.
 */
export class TurnBroadcaster {
  publish(messageId: string, event: CopilotEvent): void;
  subscribe(messageId: string, afterSeq: number): AsyncIterable<CopilotEvent>;
}
```

The wire format, one frame per event:

```
retry: 2000

id: 9f1c…:41
event: token
data: {"text":"Multi-AZ raises the monthly cost by "}

id: 9f1c…:42
event: patch_proposed
data: {"proposalId":"…","patchDigest":"…","preview":{…}}

: keepalive
```

```typescript
// apps/api/src/lib/copilot/proxy.ts
/**
 * Opens `POST ${BRAIN_URL}/copilot/turns` with the service token and the
 * authenticated user id, and yields one event per NDJSON line.
 *
 * A non-200 from the brain is returned before any SSE header is written, so a
 * refusal is an HTTP status the client can branch on rather than an `error`
 * event inside a 200. Once the first frame is written, every failure is an
 * `error` event followed by `done`.
 */
export function streamTurn(input: StreamTurnInput): AsyncIterable<CopilotEvent>;
```

Persistence cadence during a turn: `token` text is appended to `content` at most every 250ms or 512
characters, whichever comes first; `tool_call`, `tool_result`, `citation` and `patch_proposed` are
written as they arrive because they are small and are what a snapshot is made of; `done` writes the
token counts and the final status in one statement. A client disconnect aborts the request to the brain,
which is what triggers cancellation there, and the message is left `cancelled` with the text it had.

```typescript
// apps/api/src/middleware/rate-limit.ts (added)
/**
 * Keyed by session user id, falling back to the library's `ipKeyGenerator` for
 * an unauthenticated request. Not `req.ip`: this module already explains that a
 * hand-rolled IP key gives every IPv6 client its own /64.
 */
function userLimiter(windowMs: number, limit: number): RequestHandler;

/** Forty turns an hour per user. A guard on the process, not on spend. */
export const copilotTurnRateLimit = userLimiter(60 * 60 * 1000, 40);
```

Accepting a proposal is two steps in one route, in this order:

1. In one transaction: lock the proposal row, refuse anything not in status `proposed`, refuse when
   `based_on_ir_digest` no longer matches the experiment (409 `stale`), set `accepted` and `decided_at`.
2. Call `POST ${BRAIN_URL}/copilot/proposals/:id/apply`, which performs the write described in
   `020-copilot-tool-surface.md`, and return the resulting IR and digest.

Splitting it that way makes the click idempotent: if the brain is unreachable the proposal stays
`accepted`, the route returns 503 with a retryable message, and pressing accept again completes it. The
API does not apply the patch itself, even though it has `packages/core` in process, because two writers
of `experiments.ir` is exactly the kind of duplication that ends with two subtly different definitions
of what applying means.

### Files

- CREATE `db/migrations/<timestamp>_copilot_conversations.sql`
- CREATE `apps/api/src/lib/db/copilot.ts` - conversation and message reads and writes, all user-scoped
- CREATE `apps/api/src/lib/copilot/events.ts` - the mirrored union and `parseBrainEvent`
- CREATE `apps/api/src/lib/copilot/stream.ts` - SSE framing, keepalive, `TurnBroadcaster`
- CREATE `apps/api/src/lib/copilot/proxy.ts` - the NDJSON client for `services/brain`
- CREATE `apps/api/src/routes/experiments/index.ts` - the router
- CREATE `apps/api/src/routes/experiments/copilot.ts` - the transcript, turn and resume routes
- CREATE `apps/api/src/routes/experiments/proposals.ts` - accept and reject
- CREATE `apps/api/src/lib/copilot/events.test.ts` - parses `fixtures/copilot/events.example.jsonl`
- CREATE `apps/api/src/lib/copilot/stream.test.ts`
- CREATE `apps/api/src/routes/experiments/copilot.test.ts`
- CREATE `apps/api/src/lib/db/copilot.integration.test.ts`
- MODIFY `apps/api/src/index.ts` - mount `/experiments`
- MODIFY `apps/api/src/middleware/rate-limit.ts` - add `userLimiter` and `copilotTurnRateLimit`
- MODIFY `apps/api/src/middleware/rate-limit.test.ts` - cover the per-user key and its fallback
- MODIFY `apps/api/src/lib/env.ts` - add `BRAIN_URL`, default `http://localhost:8000`
- MODIFY `apps/api/.env.example` - document `BRAIN_URL` and `BRAIN_SERVICE_TOKEN`
- MODIFY `docs/DATABASE.md` - the two new tables and the one-conversation-per-experiment rule

### Acceptance Criteria

- [ ] The migration applies, rolls back and reapplies on `pgvector/pgvector:pg17`
- [ ] A second `streaming` assistant message in one conversation is refused by the unique index, and the route returns 409 rather than a 500
- [ ] Two concurrent inserts racing for the same `seq` leave one message, with the loser retried once
- [ ] `POST /experiments/:id/copilot/messages` for another user's experiment returns 404 before any call to the brain
- [ ] A refusal from the brain, including a missing BYOK credential, is returned as its own status code with no SSE frame written
- [ ] Every SSE frame carries `id: <messageId>:<seq>` with a strictly increasing sequence
- [ ] An idle stream emits a keepalive comment within 20 seconds
- [ ] A resumed stream emits exactly one `snapshot` and then only events after the client's `Last-Event-ID`
- [ ] A resume for a finished message emits the snapshot and `done` without waiting
- [ ] A client disconnect aborts the request to the brain and leaves the message `cancelled` with the text it had received
- [ ] Assistant text is persisted incrementally, so a message killed mid-turn is not empty
- [ ] An unknown event kind from the brain is logged and dropped without ending the stream
- [ ] Accepting a proposal changes `experiments.ir` exactly once and returns the resulting digest
- [ ] Accepting a proposal whose `based_on_ir_digest` no longer matches returns 409 and leaves the IR untouched
- [ ] Accepting twice applies once, and the second call returns the same digest
- [ ] Rejecting a proposal leaves `experiments.ir` byte-identical, asserted by digesting before and after
- [ ] The forty-first turn in an hour by one user is refused with the same body shape the existing limiter returns, while another user is unaffected
- [ ] No route, log line or error body contains `BRAIN_SERVICE_TOKEN` or a decrypted API key
- [ ] Deleting a user removes their conversations, messages and proposals

### Required Tests

- `refuses a second streaming turn in one conversation`
- `retries once when two inserts race for the same sequence`
- `returns 404 for another user's experiment before calling the brain`
- `forwards a brain refusal as a status code rather than an event`
- `numbers every frame with a strictly increasing id`
- `emits a keepalive on an idle stream`
- `resumes from Last-Event-ID with one snapshot and no replayed tokens`
- `resumes a finished message without blocking`
- `marks a message cancelled when the client disconnects`
- `persists assistant text incrementally during a turn`
- `drops an unknown event kind without ending the stream`
- `parses every line of the committed brain event fixture`
- `applies a proposal once and returns the resulting digest`
- `refuses to apply a proposal whose base document moved`
- `leaves the architecture byte-identical when a proposal is rejected`
- `limits turns per user rather than per address`
- `falls back to the ip key for a request with no session`
- `never logs the service token`
- `cascades conversation and message deletion from the user`

### Performance Budget

The first frame reaches the browser within 150ms of the brain's first NDJSON line, so the perceived
latency is the model's. Token frames add under 5ms of API overhead per 100 events, measured in the route
test with a scripted brain. Persistence writes at most four times a second per turn regardless of token
rate, asserted by counting statements. `GET /experiments/:id/copilot` returns a 200-message transcript
in under 50ms using `copilot_messages_conversation_idx`, with `EXPLAIN ANALYZE` recorded in the pull
request. A streaming connection holds under 1MB of heap, matching the budget #29 set for the progress
stream.

### Out of Scope

- Do not implement the turn itself, the prompt, the tools or the grounding check. This process proxies;
  `040-conversation-run-loop.md` owns the runtime
- Do not apply patches in the API. `experiments.ir` has one writer, in `020-copilot-tool-surface.md`
- Do not use websockets, and do not add a second streaming format. SSE is the decision #29 already made
  and this surface follows it
- Do not add a shared rate-limit store or a Redis dependency. The in-process store is the stated
  limitation of `rate-limit.ts` and changing it is its own issue
- Do not build the chat UI; `060-copilot-chat-surface.md` consumes these routes
- Do not add conversation titles, search, export or multiple threads per experiment. One conversation per
  experiment is the decision here, and a second thread is a schema change with a product question behind it
- Do not containerise `services/brain` or add it to `docker-compose.yml`; it has no Dockerfile and is run
  by hand as `services/brain/README.md` documents

### Dependencies

Blocked by #27 for `experiments`, #47 for durable sessions and `requireAuth`, and by
`020-copilot-tool-surface.md` for the `copilot_patch_proposals` table this migration references and the
apply endpoint the accept route calls, `030-patch-preview-deltas.md` for the `PatchPreview` carried in a
`patch_proposed` event, and `040-conversation-run-loop.md` for the brain route and the event fixture.
The SSE conventions follow #29, which is not a blocker: neither route shares code with it.

### Verification

```bash
pnpm db:migrate
pnpm db:rollback && pnpm db:migrate
pnpm --filter @infracanvas/api test
pnpm --filter @infracanvas/api test:integration
pnpm lint && pnpm typecheck
psql "$DATABASE_URL" -c "\d+ copilot_messages"
# A turn, streamed, against a running brain.
curl -N -X POST localhost:3001/experiments/$EXPERIMENT_ID/copilot/messages \
  -H 'content-type: application/json' -b cookies.txt \
  --data '{"message":"make the database highly available"}'
# The same turn, resumed from the middle.
curl -N -H 'Last-Event-ID: '"$MESSAGE_ID"':10' \
  localhost:3001/experiments/$EXPERIMENT_ID/copilot/messages/$MESSAGE_ID/events -b cookies.txt
```

### Risk Tier

tier:1 - it modifies `apps/api/src/middleware/`, which is inside Gate 7's tier-1 path expression in
`.github/workflows/gate-review.yml`, and it carries a service credential to another process

### Size

size:l - over 600 lines
