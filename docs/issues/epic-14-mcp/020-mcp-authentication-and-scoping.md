---
title: '[api] Personal access tokens that resolve to one user and scope every query by that user id'
labels: tier:1, size:l, area:api, area:db, area:brain, epic:14-mcp
---

### Epic

#118

### Context

The MCP server from `010-mcp-server-skeleton.md` reads a token from its environment and does nothing
with it. This issue makes that token mean something: it names exactly one user, it carries the set of
operations that user allowed, and it is the only thing standing between an agent on somebody's laptop
and a table full of other people's repositories and AWS connections.

**A session cookie cannot be reused here, which is why a new credential exists at all.** The existing
mechanism is a signed JWT in a cookie checked against `sessions` by
`apps/api/src/middleware/auth.ts`, and it is deliberately short-lived: `requireAuth` re-reads the row
on every request and `refreshSession` rewrites the cookie as it approaches expiry. A subprocess
launched by a coding agent has no cookie jar and no way to receive a rotated cookie, so it would have
to be handed a token that outlives the browser session - at which point it is a personal access token
with none of a personal access token's properties. It could not be revoked separately from the
browser sign-in, it could not be scoped to less than everything, and it would appear in a host's
configuration file with no prefix to recognise it by. Naming it a distinct credential in a distinct
table is what makes revoking one agent's access not mean logging out of the web application.

**The token is hashed, and the existing token table is encrypted, and both are right.** There is no
`apps/api/src/lib/crypto.ts` in this repository; the primitives live in
`apps/api/src/lib/encryption.ts`, which exports `encrypt`, `decrypt` and `hash`.
`apps/api/src/lib/db/tokens.ts` stores a GitHub access token as AES-256-GCM ciphertext because that
token has to be replayed to GitHub, so it must be recoverable. An InfraCanvas token is never replayed
anywhere; it is only ever compared to what a caller presented. Storing it reversibly would mean a
database leak hands an attacker working credentials to every user's account, so it is stored as a
SHA-256 digest and the plaintext exists exactly once, in the response that created it.

SHA-256 rather than bcrypt or Argon2, which is worth writing down because a reviewer will ask. Those
are password hashes; their cost exists to make an offline dictionary attack on a low-entropy secret
expensive. This secret is 32 bytes from a CSPRNG, so there is no dictionary and a per-request key
derivation would buy nothing while making every tool call pay for it. The digest is also
deterministic and unsalted on purpose: verification has to be a single indexed lookup on
`token_hash`, and a per-row salt would turn it into a scan of every token in the table.

**Expiry is mandatory, not optional.** `docs/issues/epic-9-deploy/010-cross-account-role-connect.md`
refused to store long-lived AWS keys on the grounds that a permanent credential in a leaked database
has no expiry to wait for, and the same reasoning applies to a credential that can deploy into that
account. `expires_at` is therefore `NOT NULL` with a database-enforced ceiling of 365 days, and the
minting route defaults to 90. A token that never expires is the failure mode this schema is built to
make unrepresentable.

**Scoping is done in the statement, not after it.** The pattern that fails is fetching a row by id
and comparing `row.user_id` to the caller afterwards, because it is one forgotten comparison away
from a cross-tenant read and the forgetting is invisible in review. Every statement in `brain/mcp`
that touches `experiments`, `repositories`, `aws_connections`, `deployments`, `artifacts` or
`loadtest_runs` therefore carries `user_id = %(user_id)s` in its own `WHERE` clause, the statements
live in one module as named constants so that claim is mechanically checkable, and a test reads them
and fails on any statement that touches those tables without the predicate. A missing row and
another user's row produce the same `not_found`, following the existing rule in
`010-cross-account-role-connect.md` that another user's connection is a 404 rather than a 403, so an
agent cannot use error codes to enumerate what exists.

**The caller's identity is a resolved dependency, never a tool argument.** The SDK's dependency
mechanism injects a parameter the model is not told about and cannot supply, and the identity of the
caller is the canonical example: a `user_id` in an input schema is a `user_id` a model can get wrong
or be talked into changing. `Principal` is injected by a resolver reading the process token, so no
tool signature in this epic has a user in it.

Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization, docs/DATABASE.md

### Contract

```sql
CREATE TABLE mcp_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Chosen by the user so they can tell one agent from another when revoking.
  name         text NOT NULL,
  -- Lowercase hex SHA-256 of the entire token string, from apps/api/src/lib/encryption.ts
  -- `hash`. Deliberately not encrypted: this value is only ever compared, never
  -- replayed, so it must not be reversible. There is no column a plaintext token
  -- could be written to.
  token_hash   char(64) NOT NULL UNIQUE,
  -- 'ic_pat_' plus the first six characters of the secret. Enough to identify a
  -- token in a log line or a host configuration file and revoke it, and not
  -- enough to authenticate with.
  token_prefix text NOT NULL,
  scopes       text[] NOT NULL,
  -- Not nullable. A credential that can deploy into an AWS account must have an
  -- end date; the ceiling is enforced here rather than in the route so a future
  -- code path cannot mint an immortal token.
  expires_at   timestamptz NOT NULL,
  -- Throttled to at most one write per MCP_TOKEN_TOUCH_INTERVAL, for the same
  -- reason sessions.last_seen_at is not written on every request.
  last_used_at timestamptz,
  -- Revoked rather than deleted, so the audit trail of what a token did survives it.
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(scopes) > 0),
  CHECK (scopes <@ ARRAY[
    'architecture:read', 'architecture:write', 'repository:analyse',
    'deploy:write', 'loadtest:write', 'destroy:write'
  ]::text[]),
  CHECK (token_prefix ~ '^ic_pat_[A-Za-z0-9_-]{6}$'),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '365 days'),
  UNIQUE (user_id, name)
);

-- The verification path is a single equality on a unique index.
-- Listing a user's live tokens is partial, because a revoked row is only ever
-- read by an audit.
CREATE INDEX mcp_tokens_user_idx ON mcp_tokens (user_id) WHERE revoked_at IS NULL;
```

The token format, which is fixed here because both languages parse it:

```text
ic_pat_<43 chars: base64url of 32 CSPRNG bytes><6 chars: base64url of CRC-32 over the 43>
^ic_pat_[A-Za-z0-9_-]{49}$
```

The checksum is not security; it lets a garbled paste be rejected locally, without a database
lookup, and it gives a secret scanner a shape it can match with almost no false positives. This is
the same reason GitHub appends one to its own tokens.

```typescript
// apps/api/src/lib/mcp/token.ts
export const MCP_TOKEN_PREFIX = 'ic_pat_';
/** 32 bytes of CSPRNG, base64url, plus a CRC-32 checksum. Never derived from user input. */
export function generateMcpToken(): { token: string; hash: string; prefix: string };
/** Shape and checksum only. False for a token that is well-formed but unknown. */
export function isWellFormedMcpToken(candidate: string): boolean;
```

```typescript
// apps/api/src/lib/db/mcp-tokens.ts
export type McpScope =
  | 'architecture:read'
  | 'architecture:write'
  | 'repository:analyse'
  | 'deploy:write'
  | 'loadtest:write'
  | 'destroy:write';

/**
 * A token as the browser is allowed to see it.
 *
 * There is deliberately no field here that could hold the token, following
 * `LlmCredential` in apps/api/src/lib/db/llm-credentials.ts: a response type
 * that cannot express the secret is stronger than remembering to strip it.
 */
export interface McpToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: McpScope[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface MintTokenInput {
  userId: string;
  name: string;
  scopes: readonly McpScope[];
  /** Clamped to MCP_TOKEN_MAX_DAYS; the database rejects anything past 365. */
  expiresInDays?: number;
}

/** The only function that ever returns a plaintext token, and only on creation. */
export function mintMcpToken(input: MintTokenInput): Promise<{ token: McpToken; secret: string }>;
export function listMcpTokens(userId: string): Promise<McpToken[]>;
/** Idempotent. Returns false when the id is not this user's, without saying which. */
export function revokeMcpToken(id: string, userId: string): Promise<boolean>;
```

Routes, mounted beside the existing settings routes and behind `requireAuth`:

| Route                             | Behaviour                                                              |
| --------------------------------- | ---------------------------------------------------------------------- |
| `POST /settings/mcp-tokens`       | Mints a token, returns the secret once and never again                 |
| `GET /settings/mcp-tokens`        | Lists the user's tokens without the secret or the hash                 |
| `DELETE /settings/mcp-tokens/:id` | Sets `revoked_at`; 404 for another user's id, 204 when already revoked |

The same token also authenticates at `apps/api`, because `040-mcp-lifecycle-tools.md` reaches deploy,
destroy and load test through the routes the browser already uses and forwards the caller's token to get
there. The alternative was a service credential the brain holds plus a header naming the user to act as,
and it was rejected: that makes the brain a component that can act as anybody, so one defect there
reaches every user's AWS account. Forwarding means the brain has exactly the authority of the token in
its hands and none between calls.

So `requireAuth` grows a second way to establish a principal, and the two produce the same request
context so no route learns which one was used:

```typescript
// apps/api/src/middleware/auth.ts
/**
 * A session cookie yields all scopes: a signed-in person operating their own
 * account is not a delegated agent, and narrowing the web application by scope
 * would be a different feature. A bearer token yields exactly its own scopes.
 */
export interface AuthenticatedRequest {
  userId: string;
  scopes: readonly McpScope[];
  /** 'session' or 'mcp_token'. Logged, never used to make a decision. */
  authMethod: AuthMethod;
}

/** 403 with the missing scope named, after requireAuth has run. */
export function requireScope(scope: McpScope): RequestHandler;
```

Bearer authentication reuses `verifyMcpToken` below rather than restating the rules, and every route
`040` calls declares the scope it needs, so a token without `deploy:write` is refused at the API
boundary as well as at the tool. Two checks of one fact is the intended redundancy here: the tool check
gives a model a clear structured error, and the API check is the one that still holds if a future
caller reaches the route another way.

```typescript
// apps/api/src/lib/db/mcp-tokens.ts
/**
 * Hash, look up, reject revoked and expired, touch last_used_at. The single
 * verification path for both surfaces; the Python side is the same three steps
 * against the same row, pinned by the shared vectors below.
 */
export function verifyMcpToken(secret: string): Promise<VerifiedMcpToken | null>;
```

The brain side. `Principal` is frozen because a tool that could widen its own scopes is not a scope
system:

```python
# services/brain/src/brain/mcp/auth.py
@dataclass(frozen=True, slots=True)
class Principal:
    user_id: UUID
    token_id: UUID
    scopes: frozenset[str]

    def require(self, scope: str) -> None:
        """Raise ToolFailure('insufficient_scope') naming the missing scope."""


#: Lowercase hex SHA-256 of the whole token string. Must agree byte for byte with
#: `hash` in apps/api/src/lib/encryption.ts; a cross-language vector test pins it.
def token_hash(token: str) -> str: ...


def is_well_formed(candidate: str) -> bool:
    """Prefix, length and checksum. Checked before any query is issued."""


async def authenticate(pool: AsyncConnectionPool, token: str | None) -> Principal:
    """Resolve a token to exactly one user.

    Raises ToolFailure('unauthenticated') for absent, malformed, unknown,
    revoked and expired tokens with the same message and the same code. The
    reason is logged; it is not returned, because telling a caller that a token
    is "expired" rather than "unknown" confirms the token was real.
    """


async def resolve_principal(ctx: Context[BrainMcpContext]) -> Principal:
    """Resolver for `Annotated[Principal, Resolve(resolve_principal)]`.

    Invisible to the model: the SDK omits a resolved parameter from the tool's
    input schema and ignores any value a client sends for it.
    """
```

The scope each tool group requires, so the mapping is decided once rather than per tool:

```python
# services/brain/src/brain/mcp/scopes.py
TOOL_SCOPES: Mapping[str, str] = {
    "read_architecture": "architecture:read",
    "explain_node": "architecture:read",
    "compare_options": "architecture:read",
    "price_change": "architecture:read",
    "propose_patch": "architecture:read",
    "apply_patch": "architecture:write",
    "analyse_repository": "repository:analyse",
    "preview_deploy": "architecture:read",
    "deploy": "deploy:write",
    "preview_load_test": "architecture:read",
    "run_load_test": "loadtest:write",
    "stop_load_test": "loadtest:write",
    "get_load_test_results": "architecture:read",
    "preview_destroy": "architecture:read",
    "destroy": "destroy:write",
    #: Watching is reading. A review agent that cannot start a deploy can still
    #: poll the one a person started, which is the useful half of the surface and
    #: spends nothing.
    "get_operation": "architecture:read",
}
```

`propose_patch` needs only `architecture:read` because it returns a proposal and changes nothing;
`apply_patch` is where the write happens. A token minted for a read-only review agent can therefore
draft an edit and cannot land it.

`tools/list` returns only the tools the process token's scopes permit. The revision allows this
explicitly - the tool set may vary by the authorization presented on the request - and on stdio the
token is fixed for the process lifetime, so the set is still constant per connection as the
specification requires.

Every statement that reads a user-owned row lives in one module, which is what makes the scoping
claim checkable:

```python
# services/brain/src/brain/mcp/sql.py
"""Every user-scoped statement in the MCP surface, in one place.

The `user_id` predicate belongs in the statement rather than in a check after
the fetch: a comparison that can be forgotten will be, and the forgetting looks
like nothing in a diff. `test_every_scoped_statement_filters_by_user_id` reads
this mapping and fails on any statement naming an owned table without it.
"""

OWNED_TABLES: frozenset[str] = frozenset(
    {"experiments", "repositories", "aws_connections", "deployments", "artifacts", "loadtest_runs"}
)

SCOPED_STATEMENTS: Mapping[str, str] = {
    "experiment_by_id": """
        SELECT e.id, e.name, e.status, e.ir, e.ir_version, e.expires_at, e.budget_usd
          FROM experiments e
         WHERE e.id = %(experiment_id)s AND e.user_id = %(user_id)s
    """,
    "repository_by_id": """
        SELECT r.id, r.github_owner, r.github_name, r.default_branch
          FROM repositories r
         WHERE r.id = %(repository_id)s AND r.user_id = %(user_id)s
    """,
    "loadtest_run_latest": """
        SELECT l.id, l.status, l.created_at
          FROM loadtest_runs l
          JOIN experiments e ON e.id = l.experiment_id
         WHERE l.experiment_id = %(experiment_id)s AND e.user_id = %(user_id)s
         ORDER BY l.created_at DESC
         LIMIT 1
    """,
}
```

```python
# services/brain/src/brain/mcp/scoping.py
async def owned_experiment(
    pool: AsyncConnectionPool, principal: Principal, experiment_id: UUID
) -> ExperimentRow:
    """Raise ToolFailure('not_found') for an id that does not exist and for one
    belonging to another user, with the same code and the same message."""


async def owned_repository(
    pool: AsyncConnectionPool, principal: Principal, repository_id: UUID
) -> RepositoryRow: ...
```

`last_used_at` is written at most once per `MCP_TOKEN_TOUCH_INTERVAL_SECONDS` (default 60) per token,
compared inside the update so two concurrent calls do not both write:

```sql
UPDATE mcp_tokens
   SET last_used_at = now()
 WHERE id = %(token_id)s
   AND (last_used_at IS NULL OR last_used_at < now() - %(interval)s::interval)
```

Gate 7 derives risk tier from the paths a pull request touches, and its expression in
`.github/workflows/gate-review.yml` covers `apps/api/src/middleware/` and
`services/brain/src/brain/codegen/` but not `services/brain/src/brain/mcp/` or
`apps/api/src/lib/mcp/`. Both are added here, in the pull request that creates them, so this code
cannot merge as tier 2 without a security review.

### Files

- CREATE `db/migrations/<timestamp>_mcp_tokens.sql`
- CREATE `apps/api/src/lib/mcp/token.ts`
- CREATE `apps/api/src/lib/db/mcp-tokens.ts`
- CREATE `apps/api/src/routes/settings/mcp-tokens.ts`
- CREATE `apps/api/src/lib/mcp/token.test.ts`
- CREATE `apps/api/src/lib/db/mcp-tokens.integration.test.ts`
- CREATE `apps/api/src/routes/settings/mcp-tokens.integration.test.ts`
- CREATE `services/brain/src/brain/mcp/auth.py`
- CREATE `services/brain/src/brain/mcp/scopes.py`
- CREATE `services/brain/src/brain/mcp/sql.py`
- CREATE `services/brain/src/brain/mcp/scoping.py`
- CREATE `services/brain/tests/test_mcp_auth.py`
- CREATE `services/brain/tests/test_mcp_scopes.py`
- CREATE `services/brain/tests/test_mcp_sql_is_user_scoped.py`
- CREATE `services/brain/tests/test_mcp_scoping_integration.py`
- CREATE `services/brain/tests/fixtures/mcp/token-hash-vectors.json` - token strings and their
  expected digests, read by both the TypeScript and the Python test
- MODIFY `services/brain/src/brain/mcp/server.py` - filter the registered tool set by scope and wire
  the principal resolver
- MODIFY `apps/api/src/middleware/auth.ts` - accept `Authorization: Bearer ic_pat_...` beside the
  session cookie, populate `scopes` and `authMethod`, and add `requireScope`
- MODIFY `apps/api/src/middleware/auth.test.ts` - the bearer path and the scope guard
- MODIFY `apps/api/src/index.ts` - mount the token router
- MODIFY `apps/api/src/lib/env.ts` - add `MCP_TOKEN_MAX_DAYS`, `MCP_TOKEN_DEFAULT_DAYS`
- MODIFY `apps/api/.env.example` - document the new variables and `INFRACANVAS_TOKEN`
- MODIFY `.github/workflows/gate-review.yml` - add `services/brain/src/brain/mcp/` and
  `apps/api/src/lib/mcp/` to the tier-1 path expression
- MODIFY `docs/DATABASE.md` - record `mcp_tokens` and why it hashes where `github_tokens` encrypts

### Acceptance Criteria

- [ ] The `mcp_tokens` table has no column capable of holding a plaintext or recoverable token, and the migration applies, rolls back and reapplies
- [ ] `POST /settings/mcp-tokens` returns the secret exactly once; every later read of that token omits it
- [ ] The plaintext token appears in no log line, no error body and no database column, asserted over the whole mint-then-authenticate path
- [ ] A token supplied in the mint request body is ignored rather than honoured
- [ ] Two `generateMcpToken` calls never collide, and the secret carries at least 32 bytes of entropy
- [ ] A token whose checksum does not match is rejected before any query is issued
- [ ] `hash` in `apps/api/src/lib/encryption.ts` and `token_hash` in `brain/mcp/auth.py` produce identical digests for every vector in the shared fixture
- [ ] An expired token, a revoked token, an unknown token and a malformed token all fail with code `unauthenticated` and the same message
- [ ] The database rejects an `expires_at` more than 365 days after `created_at`
- [ ] The database rejects a token with an empty scope array and one containing a scope not in the allowed set
- [ ] A token without `architecture:write` cannot call `apply_patch`, and the failure code is `insufficient_scope` naming the missing scope
- [ ] `tools/list` omits every tool the process token lacks the scope for, and returns the same set on two consecutive calls
- [ ] A token for user A resolving user B's experiment id receives `not_found`, and the response is byte-identical to the one for an experiment id that does not exist
- [ ] Every statement in `SCOPED_STATEMENTS` naming a table in `OWNED_TABLES` contains a `user_id` predicate, asserted by a test rather than by review
- [ ] No module under `services/brain/src/brain/mcp/` issues SQL naming an owned table outside `sql.py`
- [ ] `requireAuth` accepts a bearer token and a session cookie, and a route handler cannot tell which was used except by reading `authMethod`
- [ ] A session cookie yields every scope, so no existing route changes behaviour
- [ ] A bearer token missing a route's scope is refused with 403 naming the scope, and a revoked or expired bearer token is refused with 401
- [ ] `verifyMcpToken` and the Python `authenticate` accept and reject the same tokens for the same reasons, exercised over the shared vectors
- [ ] `last_used_at` advances on first use and is not rewritten by a second call inside the touch interval, whichever surface made the call
- [ ] Revoking a token takes effect on the next tool call without restarting the server
- [ ] Deleting a user removes their tokens

### Required Tests

- `generates distinct high entropy tokens`
- `rejects a token whose checksum does not match`
- `ignores a token supplied by the client`
- `returns the secret only from the mint response`
- `never logs the plaintext token`
- `rejects an expiry beyond the maximum`
- `rejects an unknown scope`
- `returns 404 for another users token id`
- `authenticates a bearer token and a session cookie identically`
- `grants every scope to a session and only its own to a bearer token`
- `refuses a bearer token missing the route scope with 403`
- `test_hash_matches_the_typescript_vectors`
- `test_expired_revoked_unknown_and_malformed_all_report_unauthenticated`
- `test_missing_scope_is_reported_as_insufficient_scope`
- `test_tools_list_omits_tools_the_token_cannot_call`
- `test_token_for_user_a_cannot_read_user_b_experiment`
- `test_not_found_for_another_users_experiment_is_identical_to_a_missing_one`
- `test_every_scoped_statement_filters_by_user_id`
- `test_no_owned_table_query_lives_outside_the_sql_module`
- `test_last_used_at_is_not_rewritten_within_the_touch_interval`
- `test_revoking_a_token_takes_effect_on_the_next_call`

### Performance Budget

Verifying a token is one equality lookup on `mcp_tokens_token_hash_key` and completes in under 5 ms
with 100k token rows, checked with `EXPLAIN` in the integration test so a sequential scan fails the
gate rather than merely being slow. The principal is resolved once per `tools/call` and not cached
across calls, because a revoked token has to stop working on the next call rather than when a cache
expires - one primary-key lookup is the cheapest question the database can be asked, which is the
same trade `sessionIsLive` in `apps/api/src/middleware/auth.ts` already makes. `last_used_at` costs
at most one write per token per 60 seconds, so a polling agent adds a bounded write rate rather than
one write per call.

### Out of Scope

- Do not implement OAuth 2.1, Protected Resource Metadata or dynamic client registration. They are
  required for the Streamable HTTP transport, which `010-mcp-server-skeleton.md` deliberately does
  not ship
- Do not touch `apps/api/src/lib/db/tokens.ts`, `github_tokens` or `sessions`, and do not let an MCP
  token mint a session or a session mint an MCP token. GitHub credentials and browser sessions are
  different credentials with different lifetimes, and merging the stores is how one inherits the
  other's weaknesses. `middleware/auth.ts` gains a second way to read a principal and keeps its
  session path unchanged, which is the opposite of merging them
- Do not add a web UI for minting tokens; the routes are the deliverable and the settings page
  belongs to Epic 11 (#12)
- Do not implement token rotation. Minting a second token and revoking the first produces the same
  result without a second code path, exactly as `010-cross-account-role-connect.md` argued for
  external IDs
- Do not add scopes for anything not exposed in this epic. An unused scope is a permission nobody
  has reasoned about
- Do not implement the confirmation token; it is a different credential with a different lifetime and
  belongs to `050-mcp-destructive-tool-guardrail.md`
- Do not add row-level security policies to Postgres. The application connects as one role, so RLS
  here would be configuration that looks like enforcement

### Dependencies

Blocked by `docs/issues/epic-14-mcp/010-mcp-server-skeleton.md` for the package, the lifespan context
and `ToolFailure`. Builds on the `users` table and the `hash` helper from #22, which has landed, and
on #27 for `experiments`, #24 for `repositories`, and #109 for `aws_connections` - the last three
supply tables `sql.py` names, so the statements that reference tables which do not yet exist are
added with the issue that creates them. Every other issue in this epic is blocked by this one.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm lint && pnpm typecheck
pnpm --filter @infracanvas/api test
pnpm --filter @infracanvas/api test:integration
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
uv run --directory services/brain pytest -m integration
psql "$DATABASE_URL" -c "\d+ mcp_tokens"
psql "$DATABASE_URL" -c "EXPLAIN SELECT id FROM mcp_tokens WHERE token_hash = repeat('a', 64)"
```

The cross-language digest agreement is the one claim neither suite can make alone, so the fixture is
read by both: `apps/api/src/lib/mcp/token.test.ts` asserts `hash` against it and
`services/brain/tests/test_mcp_auth.py` asserts `token_hash` against the same file. A change to
either implementation fails in both languages rather than producing a token that mints in one and
cannot authenticate in the other.

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:l - over 600 lines
