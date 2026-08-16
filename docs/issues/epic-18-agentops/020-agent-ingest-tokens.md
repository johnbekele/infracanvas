---
title: '[api] Workspace-scoped agent tokens, so an agent can report without a browser session'
labels: tier:1, size:m, area:api, area:db, epic:18-agentops
---

### Epic

#197

### Context

`010` put the run and event endpoints behind `requireAuth`, which is a browser session. An agent
running headless in a worktree has no session, so today it cannot report anything. This adds the
credential it presents instead.

The repository already holds two credential designs, and neither fits:

- **`github_tokens`** stores `access_token_encrypted`, because that token is replayed to GitHub and
  therefore has to be recoverable.
- **`BRAIN_SERVICE_TOKEN`** in `apps/api/src/middleware/service-token.ts` is a single shared secret in
  an environment variable. It cannot say which caller presented it, cannot be revoked without a
  redeploy, and is not scoped to anything.

An agent token needs the opposite of the first and more than the second: it is only ever verified, so
it must **not** be recoverable, and it must be attributable, revocable and scoped to one workspace.

**Store a hash, not ciphertext.** Verification never needs the original, so keeping one is pure
liability: a database leak yields working credentials for every agent. A hash means a leak yields
nothing usable.

**A digest is the right hash here, not a slow KDF.** Reviewers reasonably flag `sha-256` on
credentials, because for a password it is wrong — passwords have low entropy and a slow KDF buys time
against a dictionary. This token is 32 random bytes generated server-side. There is no dictionary,
and no iteration count meaningfully changes the cost of searching a 256-bit space. What matters is
that the token is unguessable and never logged.

**A non-secret prefix makes verification an indexed lookup.** Without one, verifying means reading
every unrevoked token row and comparing each, so cost grows with the number of tokens ever issued and
the comparison count itself leaks information. The prefix identifies the row; the digest then decides.

**A pairing code, not a pasted token.** `scripts/local-connector.mjs` already established the
pattern, and its header states the principle: _"Permanent InfraCanvas credentials are never accepted
or stored here."_ A short-lived one-time code is exchanged for the real token, so a long-lived secret
never has to be pasted into an agent's environment or into shell history, and a leaked code expires
on its own.

Pairing state lives in Postgres rather than in memory. The connector's in-memory map works only while
one API process exists; with two, an exchange goes to whichever process did not issue the code and
fails. That is a latent bug in the existing connector, not this issue's to fix, but this issue must
not copy it.

### Contract

Migration `db/migrations/<timestamp>_agent_tokens.sql`:

```sql
-- migrate:up

-- The credential an agent presents to report a run.
--
-- Hashed, not encrypted: this token is only ever verified, never replayed, so a
-- recoverable copy would be liability without a use. `github_tokens` stores
-- ciphertext because that token is replayed to GitHub; this one is not.
CREATE TABLE agent_tokens (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Shown in the UI so a human can tell two tokens apart before revoking one.
  name               text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Not a secret. The first 8 characters of the token, so verification finds the
  -- row by index instead of reading every row and comparing each digest.
  token_prefix       text        NOT NULL CHECK (length(token_prefix) = 8),
  -- sha-256 of the whole token, hex. 64 characters, fixed.
  token_hash         text        NOT NULL CHECK (length(token_hash) = 64),
  created_by_user_id uuid        REFERENCES users (id) ON DELETE SET NULL,
  -- Answers "is this still in use", which is what makes an unused token safe to
  -- revoke. Written at most once a minute, not on every request, so a reporting
  -- agent does not turn every event into a write.
  last_used_at       timestamptz,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Verification's exact predicate. Unique because a prefix collision would make
-- the lookup ambiguous; the generator retries on conflict.
CREATE UNIQUE INDEX agent_tokens_prefix_idx ON agent_tokens (token_prefix);

CREATE INDEX agent_tokens_workspace_idx ON agent_tokens (workspace_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER agent_tokens_set_updated_at
  BEFORE UPDATE ON agent_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A one-time code exchanged for a token.
--
-- In Postgres, not in memory: with two API processes an exchange reaches
-- whichever one did not issue the code, and an in-memory map fails half the time
-- behind a load balancer.
CREATE TABLE agent_pairings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Hashed for the same reason the token is: a pairing code is a credential for
  -- as long as it lives.
  code_hash     text        NOT NULL CHECK (length(code_hash) = 64),
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_by_user_id uuid   REFERENCES users (id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  -- Set on exchange. One-time use is enforced by this being null.
  redeemed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agent_pairings_code_idx ON agent_pairings (code_hash);

-- migrate:down

DROP TABLE IF EXISTS agent_pairings;
DROP TABLE IF EXISTS agent_tokens;
```

`apps/api/src/lib/db/agent-tokens.ts`:

```ts
export interface AgentToken {
  id: string;
  workspaceId: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** The plaintext is returned here and never again; only its digest is stored. */
export interface IssuedAgentToken {
  token: AgentToken;
  plaintext: string;
}

export async function createPairingCode(input: {
  workspaceId: string;
  name: string;
  createdByUserId: string;
  ttlMs?: number;
}): Promise<{ code: string; expiresAt: Date }>;

/**
 * Redeems a code once. Returns null for a code that is unknown, expired or
 * already redeemed -- one indistinguishable answer, so a caller cannot tell which
 * of the three it hit.
 */
export async function redeemPairingCode(code: string): Promise<IssuedAgentToken | null>;

/** Null for absent, malformed, unknown, revoked or expired. Constant time in the digest compare. */
export async function verifyAgentToken(presented: string): Promise<AgentToken | null>;

export async function listAgentTokens(workspaceId: string): Promise<AgentToken[]>;

/** Idempotent: revoking an already-revoked token is not an error. */
export async function revokeAgentToken(id: string): Promise<void>;
```

`apps/api/src/middleware/agent-token.ts`:

```ts
export const AGENT_TOKEN_HEADER = 'authorization'; // Bearer <token>

/** Minimum length of a token this will even look at. */
export const MIN_AGENT_TOKEN_LENGTH = 32;

/**
 * Populates `req.agentToken` and refuses everything else with 401. Follows
 * `service-token.ts`: digests both sides before `timingSafeEqual`, so the compare
 * is constant time and independent of length, and logs the outcome without
 * logging anything off the request.
 */
export function requireAgentToken(req: Request, res: Response, next: NextFunction): void;

/** Session or agent token. Used by the `010` write endpoints. */
export function requireAuthOrAgentToken(req: Request, res: Response, next: NextFunction): void;
```

Routes, `apps/api/src/routes/workspaces/agent-tokens.ts`:

```
POST   /api/workspaces/:workspaceId/agent-tokens/pair   -> 201 { code, expiresAt }   session only
POST   /api/agent-tokens/exchange                       -> 201 { token }             no auth, code in body
GET    /api/workspaces/:workspaceId/agent-tokens        -> 200 AgentToken[]          session only
DELETE /api/agent-tokens/:id                            -> 204                       session only
```

Token format: `ica_` followed by 32 bytes as base64url. The `ica_` prefix makes a leaked token
greppable in logs and scannable by `gitleaks`, and the stored `token_prefix` is the first 8
characters of the whole string.

`010`'s write endpoints change from `requireAuth` to `requireAuthOrAgentToken`, and an agent token may
only write runs in its own workspace.

### Files

- `db/migrations/<timestamp>_agent_tokens.sql` — NEW.
- `apps/api/src/lib/db/agent-tokens.ts` — NEW.
- `apps/api/src/lib/db/agent-tokens.integration.test.ts` — NEW.
- `apps/api/src/middleware/agent-token.ts` — NEW.
- `apps/api/src/middleware/agent-token.test.ts` — NEW.
- `apps/api/src/routes/workspaces/agent-tokens.ts` — NEW.
- `apps/api/src/routes/workspaces/agent-tokens.test.ts` — NEW.
- `apps/api/src/routes/workspaces/agent-runs.ts` — MODIFY: accept either credential.
- `.gitleaks.toml` — MODIFY: a rule for the `ica_` prefix, if the file exists.

### Acceptance Criteria

- [ ] Creating a pairing code returns the code and its expiry, and stores only a digest of it.
- [ ] Exchanging a valid code returns a token whose plaintext appears in that response and nowhere else.
- [ ] Exchanging the same code twice fails the second time.
- [ ] Exchanging an expired code fails.
- [ ] An unknown, expired and already-redeemed code produce the same status and the same message.
- [ ] A valid token authenticates a run write for its own workspace.
- [ ] A valid token is refused for a run in a different workspace.
- [ ] A revoked token is refused.
- [ ] An expired token is refused.
- [ ] A token below `MIN_AGENT_TOKEN_LENGTH` is refused without a database read.
- [ ] No response, log line or error message ever contains a token, a code, or a digest of either.
- [ ] `last_used_at` advances on use, and does not write more than once a minute for the same token.
- [ ] Revoking is idempotent.
- [ ] Deleting a workspace deletes its tokens and pairings.
- [ ] The migration applies, rolls back, and applies again cleanly.

### Required Tests

`agent-tokens.integration.test.ts`:

- `stores only a digest of the pairing code`
- `exchanges a code once and refuses the second attempt`
- `refuses an expired code`
- `answers identically for unknown, expired and redeemed codes`
- `stores only a digest of the token`
- `verifies a valid token`
- `refuses a revoked token`
- `refuses an expired token`
- `refuses a token whose prefix matches but whose digest does not`
- `throttles last_used_at to at most one write a minute`
- `revokes idempotently`
- `deletes tokens and pairings with the workspace`
- `migration rolls back cleanly`

`agent-token.test.ts`:

- `refuses a request with no Authorization header`
- `refuses a token below the minimum length without touching the database`
- `refuses a malformed Authorization header`
- `logs the refusal without logging the presented token`

`agent-tokens.test.ts` (routes):

- `requires a session to create a pairing code`
- `returns the token plaintext exactly once`
- `refuses an agent token writing to another workspace`
- `requires a session to list or revoke`

### Performance Budget

- `verifyAgentToken` is a single indexed lookup on `agent_tokens_prefix_idx` plus one fixed 32-byte
  compare, under 5 ms server-side at 10,000 issued tokens, asserted with
  `EXPLAIN (ANALYZE, FORMAT JSON)`.

### Out of Scope

- Fixing the existing connector's in-memory pairing map. Named in Context as a latent multi-process
  bug; it is `epic-0-delivery` work, and touching it here widens a tier-1 review.
- Replacing `BRAIN_SERVICE_TOKEN`. The internal plane keeps its shared secret.
- Rate limiting the exchange endpoint. It needs the library chosen in
  `epic-0-delivery/120-rate-limiting-library.md`; this issue must not hand-roll one.
- Per-lane or per-issue token scoping. Workspace scope only.
- Token rotation without revocation, and any UI. The UI is part of `030`.

### Dependencies

- `010-agent-run-and-event-model.md` — the endpoints this credential protects.
- #190 — `workspaces`, for the foreign key.

### Risk Tier

tier:1 — Introduces a credential, so it needs a passing security review in addition to every other gate.

### Size

size:m

### Verification

```bash
pnpm db:migrate && pnpm db:rollback && pnpm db:migrate
pnpm --filter @infracanvas/api exec vitest run src/lib/db/agent-tokens.integration.test.ts \
  --config vitest.integration.config.ts
pnpm --filter @infracanvas/api exec vitest run src/middleware/agent-token.test.ts \
  src/routes/workspaces/agent-tokens.test.ts
# No credential reaches a log or a response body.
rg -n 'plaintext|token' apps/api/src/lib/db/agent-tokens.ts | rg -i 'console|log'
pnpm verify
```
