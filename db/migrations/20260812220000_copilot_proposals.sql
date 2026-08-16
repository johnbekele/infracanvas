-- migrate:up

CREATE TYPE copilot_proposal_status AS ENUM (
  'proposed', 'accepted', 'applied', 'rejected', 'superseded'
);

-- One edit the copilot offered, and what became of it.
--
-- The row keeps the bytes the user was shown rather than a recipe for
-- recomputing them: `patched_ir` is the document the preview plane produced and
-- priced, and applying writes it verbatim. "What was previewed is what was
-- applied" is therefore a property of these bytes rather than of two
-- implementations of the patch algebra still agreeing a year from now.
CREATE TABLE copilot_proposals (
  id            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid  NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  -- Copied from the experiment at insert rather than reached through a join, so
  -- that every read predicate can carry the user without one. CASCADE for the
  -- same reason the experiment cascades: a closed account leaves no proposals.
  user_id       uuid  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Identifies the exact operations and excludes their prose summary, so
  -- rewording a diff card does not turn one proposal into two.
  patch_digest  text  NOT NULL,
  -- The document this was computed and priced against. Applying compares it with
  -- the experiment's current digest, which is what makes a proposal whose base
  -- has moved refusable instead of quietly applied to something else.
  based_on_ir_digest text NOT NULL,
  patch         jsonb NOT NULL,
  -- Computed at proposal time, because by the time anyone wants to undo the edit
  -- the document has moved on and the inverse can no longer be derived from it.
  inverse       jsonb NOT NULL,
  patched_ir    jsonb NOT NULL,
  preview       jsonb NOT NULL,
  status        copilot_proposal_status NOT NULL DEFAULT 'proposed',
  -- The model's stated reason. Displayed; never parsed.
  rationale     text  NOT NULL,
  applied_ir_digest text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Exactly the applied proposals say what the document became. A digest on any
  -- other row would claim a write that never happened, and that claim is what a
  -- later "has this already been applied?" would be answered from.
  CONSTRAINT copilot_proposals_applied_ck
    CHECK ((status = 'applied') = (applied_ir_digest IS NOT NULL)),
  -- An open proposal has no decision, and every other state has one. Superseded
  -- counts as decided: it was closed by a later edit, and a card the user can no
  -- longer act on with no date against it is unexplainable afterwards.
  CONSTRAINT copilot_proposals_decided_ck
    CHECK ((status = 'proposed') = (decided_at IS NULL)),
  -- No format is asserted beyond non-emptiness. The digest function is the
  -- application's, and pinning its current width here would make changing the
  -- hash a schema migration for no gain.
  CONSTRAINT copilot_proposals_digest_ck
    CHECK (length(patch_digest) > 0 AND length(based_on_ir_digest) > 0),
  -- jsonb happily stores a bare string or number, and all four of these columns
  -- are documents the application deserialises into typed objects.
  CONSTRAINT copilot_proposals_json_ck CHECK (
    jsonb_typeof(patch) = 'object'
    AND jsonb_typeof(inverse) = 'object'
    AND jsonb_typeof(patched_ir) = 'object'
    AND jsonb_typeof(preview) = 'object'
  )
);

-- "Proposing the same edit twice is one proposal", as a constraint rather than a
-- convention the next writer can forget: a model that repeats itself while the
-- first card is still open must not fill the user's list with duplicates of one
-- decision, and it is also the exact lookup the open-proposal read performs.
--
-- Partial, because the same edit may legitimately be proposed again once the
-- first was decided: that is a new question, asked of a document that has moved.
-- The user is not in the key because an experiment has exactly one owner, so the
-- pair is already unique per user.
CREATE UNIQUE INDEX copilot_proposals_open_idx
  ON copilot_proposals (experiment_id, patch_digest)
  WHERE status = 'proposed';

-- The diff cards of one experiment, newest first.
CREATE INDEX copilot_proposals_experiment_idx
  ON copilot_proposals (experiment_id, created_at DESC);

CREATE TRIGGER copilot_proposals_set_updated_at
  BEFORE UPDATE ON copilot_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One conversation per experiment, enforced by the UNIQUE rather than by whoever
-- inserts: the transcript is about a single architecture, and two conversations
-- against one document would each answer questions about a state the other was
-- in the middle of changing.
CREATE TABLE copilot_conversations (
  id            uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid  NOT NULL UNIQUE REFERENCES experiments (id) ON DELETE CASCADE,
  user_id       uuid  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE copilot_message_status AS ENUM (
  'streaming', 'complete', 'limit', 'cancelled', 'error'
);

-- One turn, and everything a reconnecting client is handed for it.
--
-- Rows are written as the turn proceeds rather than at the end, so a turn killed
-- halfway leaves what the user already read. `last_event_seq` is what a resuming
-- `EventSource` sends back as `Last-Event-ID`, which is what makes resumption a
-- cursor rather than a guess.
CREATE TABLE copilot_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES copilot_conversations (id) ON DELETE CASCADE,
  -- Dense and 1-based per conversation, allocated under the conversation row's
  -- lock rather than by a caller, so two concurrent appends cannot pick the same
  -- number and one of them lose to the unique index below.
  seq             integer NOT NULL,
  role            text    NOT NULL,
  content         text    NOT NULL,
  -- Summaries only. A tool's arguments can carry a whole patch, and the proposal
  -- row already holds those bytes.
  tool_calls      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  citations       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  -- SET NULL rather than CASCADE: the turn that proposed an edit is part of the
  -- conversation whatever later became of the proposal.
  proposal_id     uuid    REFERENCES copilot_proposals (id) ON DELETE SET NULL,
  status          copilot_message_status NOT NULL,
  last_event_seq  integer NOT NULL DEFAULT 0,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  unverified_citations integer NOT NULL DEFAULT 0,
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A turn whose process died stays `streaming` for ever, and this is how such a
  -- row is found again: "streaming and untouched for minutes" is the only
  -- description of a stranded turn that does not rely on the process that
  -- stranded it.
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (conversation_id, seq),
  CONSTRAINT copilot_messages_seq_ck  CHECK (seq > 0),
  CONSTRAINT copilot_messages_role_ck CHECK (role IN ('user', 'assistant')),
  CONSTRAINT copilot_messages_counts_ck CHECK (
    last_event_seq >= 0 AND input_tokens >= 0 AND output_tokens >= 0
    AND unverified_citations >= 0
  ),
  CONSTRAINT copilot_messages_json_ck CHECK (
    jsonb_typeof(tool_calls) = 'array' AND jsonb_typeof(citations) = 'array'
  ),
  -- One direction only. A code without an error would be a lie, but a turn can
  -- end in `error` with nothing more specific to say than that the provider
  -- stopped talking, and refusing to record that turn is worse than recording it
  -- without a code.
  CONSTRAINT copilot_messages_error_ck CHECK (error_code IS NULL OR status = 'error')
);

-- One streaming turn per conversation. A guard in the API would be a read
-- followed by a write, and it loses precisely the race it exists for: two tabs,
-- or a retry arriving while the first request is still opening its turn. Two
-- live turns against one architecture would each propose patches against a
-- document the other was about to change, and the damage would surface much
-- later as a stale proposal nobody could explain.
CREATE UNIQUE INDEX copilot_messages_streaming_idx
  ON copilot_messages (conversation_id)
  WHERE status = 'streaming';

CREATE TRIGGER copilot_messages_set_updated_at
  BEFORE UPDATE ON copilot_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- migrate:down

DROP TABLE IF EXISTS copilot_messages;
DROP TYPE IF EXISTS copilot_message_status;
DROP TABLE IF EXISTS copilot_conversations;
DROP TABLE IF EXISTS copilot_proposals;
DROP TYPE IF EXISTS copilot_proposal_status;
