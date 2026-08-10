---
title: '[brain] Single-use confirmation tokens bound to a plan hash for every tool that spends or destroys'
labels: tier:1, size:m, area:brain, area:db, epic:14-mcp
---

### Epic

#118

### Context

Three of the tools in `040-mcp-lifecycle-tools.md` cost money or remove infrastructure: `deploy`
starts a CodeBuild run that provisions resources into somebody's AWS account, `run_load_test` launches
a Fargate task and drives traffic at them, and `destroy` deletes them. The caller is a language model
in a loop. This issue is what stands between those two facts.

**The protocol cannot be the guardrail, and it says so.** The tools specification asks clients to
prompt for confirmation on sensitive operations, but that is a SHOULD, the `destructive_hint`
annotation is explicitly "untrusted unless from a trusted server", and the specification's own
guidance says annotations "are hints, not security. Never rely on a client honouring them." Some hosts
do prompt; some auto-approve whole tool namespaces on the user's behalf, which is a feature people
enable precisely so they are not interrupted. A guardrail that lives in the client is a guardrail that
is off in the configuration where it matters most.

**Elicitation was the obvious alternative and was rejected on two grounds.** The SDK can pause a tool
call and ask the user a question, which reads like exactly the right mechanism. But elicitation is a
client capability: a host that has not declared it refuses the call, so the guardrail would either be
absent or would break the tool depending on the host - the same dependence on client behaviour in a
different costume. And even where it works, an elicitation binds a yes to a question string, not to a
plan. The user answers "deploy this?" while the thing that gets deployed is whatever the IR says at
the moment the build starts, which is not necessarily what the preview described. A server-side token
bound to a hash of the plan closes that gap, and it works identically on every host.

**So a confirmation is a credential the server issues, and getting one requires being told what will
happen.** `preview_deploy` computes the plan - the resources that will be created, their estimated
monthly cost, the region, the account, the TTL and the budget the experiment is bound by - stores it,
and returns it together with a token. `deploy` will not run without that token, and the token only
works for the plan it was issued for. An agent that wants to deploy therefore cannot avoid producing,
in its own transcript, a statement of what it is about to spend. That is the property worth having:
not that a human necessarily reads it, but that it exists, in the conversation, before the money is
committed, and that the thing executed is provably the thing described.

**An agent in a loop must not accumulate permission.** Four rules make looping useless rather than
merely inefficient. The token is single use, enforced by the `consumed_at IS NULL` predicate inside
the consuming `UPDATE` so two concurrent calls resolve in the database rather than in application
code. It is bound to `plan_hash`, so a token issued before an `apply_patch` does not work after one.
A new preview for the same experiment and action replaces the outstanding confirmation, so only the
most recent preview's token can ever be redeemed and calling `preview_deploy` in a loop produces one
usable token, not a hundred. And previews are themselves capped per token per experiment per hour, so
a loop is refused with `rate_limited` instead of grinding. The token is 32 bytes of CSPRNG, so a model
cannot fabricate one; the only outcome of guessing is `confirmation_invalid`.

**This is additional to the guardrails in epic 9, not a replacement for them, and the reaper is
deliberately exempt.** `docs/issues/epic-9-deploy/050-ttl-and-budget-reaper.md` (#113) bounds the
damage after the fact: every experiment carries `expires_at` and `budget_usd` from #27, the TTL is what
actually limits spend because Cost Explorer lags by up to a day, and an over-long TTL is reaped
regardless of what the row says. The confirmation is a different control at a different moment - it
bounds what starts, where the TTL bounds what continues - and the preview states both figures because
a user confirming a deploy is confirming a bounded spend and the bound is the reaper's. Two
consequences follow. `preview_deploy` refuses a plan whose TTL exceeds `MAX_EXPERIMENT_TTL_HOURS`,
because the reaper would destroy it within the hour and a preview that promised otherwise would be a
lie. And `preview_deploy` refuses a plan whose estimated cost over its own TTL exceeds `budget_usd`,
naming both numbers: #113 explicitly leaves pre-deploy cost refusal to whoever reads the prediction
model, and this is that place. The reaper's own destroys call #112's handler directly and never obtain
a confirmation, because a safety net that needs a token from an agent is not a safety net.

Spec: docs/issues/epic-9-deploy/050-ttl-and-budget-reaper.md, docs/issues/epic-9-deploy/040-one-click-destroy.md

### Contract

```sql
CREATE TYPE mcp_confirmation_action AS ENUM ('deploy', 'loadtest', 'destroy');

CREATE TABLE mcp_confirmations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Bound to the token that previewed, so a second agent cannot redeem the
  -- confirmation a first one was shown.
  token_id      uuid NOT NULL REFERENCES mcp_tokens (id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  action        mcp_confirmation_action NOT NULL,
  -- SHA-256 over the canonical preview document. The executing call recomputes it
  -- from current state and refuses on any difference, so a plan the caller was
  -- never shown cannot be executed with a token issued for one it was.
  plan_hash     char(64) NOT NULL,
  -- Verbatim, so an audit says what the caller was actually told rather than what
  -- the code would compute today.
  preview       jsonb NOT NULL,
  -- SHA-256 of the confirmation secret. There is deliberately no column the
  -- secret itself could be written to.
  confirmation_hash char(64) NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  -- Set by the consuming UPDATE. Single use is this column plus the predicate.
  consumed_at   timestamptz,
  -- The operation handle from 040-mcp-lifecycle-tools.md, so an audit joins a
  -- confirmation to the thing it authorised. Text rather than a foreign key
  -- because a deploy is a jobs row and a load test is a loadtest_runs row, and a
  -- column that could only reference one of them would be null for the other.
  consumed_by_operation text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  -- consumed_at without an operation is a legitimate state: the token was
  -- redeemed and the start call then failed. The reverse is not.
  CHECK (consumed_by_operation IS NULL OR consumed_at IS NOT NULL),
  CHECK (consumed_by_operation IS NULL OR consumed_by_operation ~ '^op_[a-z]+_[0-9a-f-]{36}$')
);

-- At most one live confirmation per experiment and action. A fresh preview
-- replaces the outstanding one, so an agent that loops on preview_deploy ends up
-- with exactly one redeemable token rather than one per iteration.
CREATE UNIQUE INDEX mcp_confirmations_live_idx
  ON mcp_confirmations (experiment_id, action)
  WHERE consumed_at IS NULL;

-- Drives the per-token preview rate limit and the audit of what was confirmed.
CREATE INDEX mcp_confirmations_token_idx
  ON mcp_confirmations (token_id, experiment_id, created_at DESC);
```

The token format, distinct from the access token in `020-mcp-authentication-and-scoping.md` so the two
can never be confused at a call site or in a log:

```text
ic_cnf_<43 chars: base64url of 32 CSPRNG bytes>
^ic_cnf_[A-Za-z0-9_-]{43}$
```

```python
# services/brain/src/brain/mcp/confirm.py
CONFIRMATION_PREFIX = "ic_cnf_"

#: Long enough for a person to read a preview in a chat client and answer, short
#: enough that a token left in a transcript is dead before the transcript is
#: replayed tomorrow.
CONFIRMATION_TTL_SECONDS = 600
MAX_PREVIEWS_PER_TOKEN_PER_EXPERIMENT_PER_HOUR = 10


class ResourcePlanLine(BaseModel):
    kind: str            # IR resource kind, e.g. 'rds_instance'
    count: int
    monthly_usd: float | None  # None means unpriced; never silently zero.


class DeployPlan(BaseModel):
    """What preview_deploy states and what plan_hash is computed over."""

    action: Literal["deploy"]
    experiment_id: UUID
    ir_version: str
    #: ArchitectureView.ir_digest. Ties the plan to an exact IR document, so any
    #: edit invalidates the token. Epic 13's digest excludes layout and
    #: presentation, so rearranging the canvas while reading a preview does not
    #: invalidate a confirmation, while changing any parameter does.
    ir_digest: str
    aws_account_id: str
    aws_region: str
    creates: list[ResourcePlanLine]
    #: From rollUpCost in #101. Unpriced resources are listed, not omitted.
    estimated_monthly_usd: float
    unpriced: list[str]
    #: The guardrails from #27 that the reaper in #113 will enforce.
    expires_at: datetime
    budget_usd: float
    #: estimated_monthly_usd pro-rated over the TTL. Compared against budget_usd.
    estimated_ttl_usd: float


class DestroyPlan(BaseModel):
    """What preview_destroy states. Read-only: it queries, it deletes nothing."""

    action: Literal["destroy"]
    experiment_id: UUID
    aws_account_id: str
    aws_region: str
    stack_name: str
    #: Currently tagged with this experiment, from the same tag query #112 sweeps
    #: with. A resource created outside Pulumi's state appears here.
    destroys: list[ResourcePlanLine]
    resource_arns: list[str]
    #: True when the tag index returned nothing, which after a deploy usually
    #: means the index is still catching up rather than that nothing exists.
    nothing_found: bool


class LoadTestPlan(BaseModel):
    action: Literal["loadtest"]
    experiment_id: UUID
    deployment_id: UUID
    stages: int
    peak_target_rps: int
    estimated_duration_ms: int
    #: Spot compute for the ramp, from #70's budget. The traffic it drives at the
    #: deployment also costs money, and that figure is stated separately.
    estimated_generator_usd: float
    estimated_traffic_usd: float


class Confirmation(BaseModel):
    """Returned beside every plan."""

    confirmation_token: str
    expires_at: datetime
    plan_hash: str
    #: One sentence a host can show a user without rendering the whole plan.
    #: Example: "Deploy 11 resources into 123456789012/eu-west-1 for about
    #: 74.20 USD a month, destroyed automatically in 8 hours."
    summary: str


def canonical_plan_hash(plan: DeployPlan | DestroyPlan | LoadTestPlan) -> str:
    """SHA-256 over the plan serialised with sorted keys and no whitespace.

    Canonical because the same plan must hash identically when recomputed at
    execution time in a different process; key order from a dict literal is not
    something to bet a deploy on.
    """


async def issue_confirmation(
    pool: AsyncConnectionPool,
    principal: Principal,
    plan: DeployPlan | DestroyPlan | LoadTestPlan,
) -> Confirmation:
    """Store the plan and return a fresh token.

    Replaces any live confirmation for the same experiment and action in one
    statement, so the previously issued token stops working the moment a new
    preview is taken. Raises ToolFailure('rate_limited') past the hourly cap.
    """


async def consume_confirmation(
    conn: AsyncConnection,
    principal: Principal,
    experiment_id: UUID,
    action: str,
    confirmation_token: str,
    plan_hash: str,
) -> ConsumedConfirmation:
    """Redeem a token, or refuse.

    Commits before the start call in 040-mcp-lifecycle-tools.md is made, and
    deliberately not after. The operation runs in apps/api, so there is no
    transaction the two can share, and one of the orders is unsafe: starting
    first means a crash in between leaves infrastructure created by a token that
    was never redeemed and can be redeemed again. Consuming first means a crash
    in between burns a token and creates nothing, which costs the caller one
    preview. Raises ToolFailure('confirmation_invalid') when the statement below
    updates no row. Returns the stored preview, which the caller records so an
    audit reads what was promised.
    """


async def attach_operation(
    conn: AsyncConnection, confirmation_id: UUID, operation_id: str
) -> None:
    """Record which operation the redeemed token authorised, once the start call
    has returned one. A consumed row with no operation is therefore a start that
    did not complete, which is a state an operator should be able to see rather
    than one the schema hides."""
```

Redemption is one statement, and single use is a database property rather than a code path:

```sql
UPDATE mcp_confirmations
   SET consumed_at = now()
 WHERE confirmation_hash = %(confirmation_hash)s
   AND user_id = %(user_id)s
   AND token_id = %(token_id)s
   AND experiment_id = %(experiment_id)s
   AND action = %(action)s
   AND plan_hash = %(plan_hash)s
   AND consumed_at IS NULL
   AND expires_at > now()
RETURNING id, preview
```

Every mismatch - wrong user, wrong token, wrong experiment, wrong action, stale plan, already
consumed, expired - produces zero rows and therefore the same `confirmation_invalid`, with the actual
reason logged and not returned. Distinguishing "expired" from "already used" would tell a caller that
the token was real.

`plan_hash` is passed in by the caller because it is recomputed from current state at execution time
rather than read back from the row. Reading it back would make the check circular: the row would
confirm itself. Recomputing means an `apply_patch` between preview and deploy changes `ir_digest`,
changes the hash, and the deploy is refused with an error naming the field that moved.

The three preview tools, registered by this package rather than imported, because a preview is a
statement about what an MCP call is about to do and has no counterpart in the chat surface, which
shows the same information in the canvas:

```python
# services/brain/src/brain/mcp/tools/previews.py
async def preview_deploy(experiment_id: UUID, ...) -> tuple[DeployPlan, Confirmation]:
    """State what deploying this experiment will create and what it will cost.

    Creates nothing. Returns a confirmation token valid for ten minutes, which
    the deploy tool requires. Taking a new preview invalidates the previous token.
    """


async def preview_destroy(experiment_id: UUID, ...) -> tuple[DestroyPlan, Confirmation]:
    """List what destroying this experiment will remove. Deletes nothing."""


async def preview_load_test(experiment_id: UUID, ...) -> tuple[LoadTestPlan, Confirmation]:
    """State the ramp, its duration and its cost. Starts nothing."""
```

Each returns both a `TextContent` block holding `summary` and `structuredContent` holding the plan, so
a host that shows tool results to a user shows the sentence, and a client application can render the
lines.

`preview_deploy` refuses rather than warns in three cases, each cross-referenced to the guardrail it
is protecting:

| Condition                                                                         | Code               |
| --------------------------------------------------------------------------------- | ------------------ |
| `expires_at - now()` exceeds `MAX_EXPERIMENT_TTL_HOURS` from #113                 | `invalid_argument` |
| `estimated_ttl_usd` exceeds `budget_usd` from #27                                 | `invalid_argument` |
| No verified `aws_connections` row for this user, or the experiment is not `ready` | `conflict`         |

All three name the two numbers or the missing precondition in the message, because a refusal an agent
cannot act on becomes a retry loop.

`preview_destroy` never refuses on cost and never refuses because the tag query came back empty: #112
is explicit that the tagging API is eventually consistent and that an experiment with no deployment row
must still be swept, so `nothing_found` is reported and the destroy is allowed.

### Files

- CREATE `db/migrations/<timestamp>_mcp_confirmations.sql`
- CREATE `services/brain/src/brain/mcp/confirm.py`
- CREATE `services/brain/src/brain/mcp/plans.py` - the three plan models and `canonical_plan_hash`
- CREATE `services/brain/src/brain/mcp/tools/previews.py`
- CREATE `services/brain/tests/test_mcp_plan_hash.py`
- CREATE `services/brain/tests/test_mcp_confirm.py`
- CREATE `services/brain/tests/test_mcp_previews.py`
- CREATE `services/brain/tests/test_mcp_confirm_integration.py`
- CREATE `services/brain/tests/fixtures/mcp/deploy-plan.json` - the canonical serialisation and its
  expected hash
- MODIFY `services/brain/src/brain/mcp/sql.py` - add the confirmation statements
- MODIFY `services/brain/src/brain/mcp/scopes.py` - map the three preview names to
  `architecture:read`
- MODIFY `services/brain/src/brain/mcp/server.py` - register the preview tools
- MODIFY `services/brain/tests/fixtures/mcp/tools-list.json` - regenerated with the preview tools
- MODIFY `services/brain/README.md` - the preview-then-execute contract and the ten-minute lifetime
- MODIFY `docs/DATABASE.md` - record `mcp_confirmations` and why the plan hash is recomputed rather
  than read back

### Acceptance Criteria

- [ ] `deploy`, `run_load_test` and `destroy` called with no `confirmation_token` are rejected by the generated input schema before the tool body runs
- [ ] A confirmation token is 32 bytes of CSPRNG and is stored only as a SHA-256 digest; no column can hold the secret
- [ ] The same token redeemed twice succeeds once and fails once with `confirmation_invalid`, and the two attempts running concurrently produce the same one-success outcome
- [ ] A token issued before an `apply_patch` is refused after it, with the message naming `ir_digest`
- [ ] A layout-only edit between preview and deploy does not invalidate the token, since `ir_digest` excludes layout
- [ ] A confirmation consumed for a start call that then failed is left `consumed_at` set with no operation, and cannot be redeemed again
- [ ] A token issued for `deploy` cannot be redeemed by `destroy`, and one issued for experiment A cannot be redeemed for experiment B
- [ ] A token issued to one access token cannot be redeemed by another, even for the same user
- [ ] A token past `expires_at` is refused, and expired, consumed, unknown and mismatched tokens all report `confirmation_invalid` with the same message
- [ ] Taking a second preview for the same experiment and action makes the first token unredeemable, and the database holds exactly one live confirmation for that pair
- [ ] The eleventh preview for one experiment within an hour on one token reports `rate_limited` and issues no token
- [ ] `canonical_plan_hash` is identical across processes and across dict insertion orders for the same plan
- [ ] `preview_deploy` states the resources to be created, the estimated monthly cost, the unpriced resources, `expires_at` and `budget_usd`, and never reports an unpriced resource as costing zero
- [ ] `preview_deploy` refuses a TTL beyond `MAX_EXPERIMENT_TTL_HOURS`, naming the TTL and the maximum
- [ ] `preview_deploy` refuses when the cost over the TTL exceeds `budget_usd`, naming both figures
- [ ] `preview_destroy` lists the currently tagged resources and their ARNs, creates and deletes nothing, and reports `nothing_found` rather than refusing when the tag query is empty
- [ ] Every preview returns a one-sentence `summary` in a text block as well as the structured plan
- [ ] The token is consumed and committed before the start call is made, so a start that fails leaves a burnt token and no infrastructure rather than a live token and a running deploy
- [ ] The stored `preview` is readable after execution and matches what the preview call returned
- [ ] A destroy enqueued by the reaper from #113 consumes no confirmation and is unaffected by this issue
- [ ] A preview for another user's experiment reports `not_found`, identically to one that does not exist

### Required Tests

- `test_destructive_tools_require_a_confirmation_token_in_the_schema`
- `test_a_token_is_redeemable_exactly_once`
- `test_concurrent_redemption_succeeds_once`
- `test_a_token_is_refused_after_the_ir_changes`
- `test_a_token_for_one_action_cannot_be_used_for_another`
- `test_a_token_for_one_experiment_cannot_be_used_for_another`
- `test_a_token_issued_to_another_access_token_is_refused`
- `test_expired_consumed_and_unknown_tokens_are_indistinguishable`
- `test_a_new_preview_invalidates_the_previous_token`
- `test_preview_rate_limit_refuses_a_looping_agent`
- `test_plan_hash_is_independent_of_key_order`
- `test_deploy_preview_states_cost_ttl_budget_and_unpriced_resources`
- `test_deploy_preview_refuses_a_ttl_beyond_the_maximum`
- `test_deploy_preview_refuses_a_plan_over_its_budget`
- `test_destroy_preview_lists_arns_and_deletes_nothing`
- `test_destroy_preview_reports_nothing_found_rather_than_refusing`
- `test_a_failed_start_leaves_the_token_burnt_and_nothing_running`
- `test_a_consumed_token_records_the_operation_it_authorised`
- `test_reaper_destroy_needs_no_confirmation`
- `test_preview_refuses_another_users_experiment`

### Performance Budget

`preview_destroy` completes in under 3 seconds, dominated by one `GetResources` call per region
against the tagging API; it does not retry, because unlike #112's sweep it is describing rather than
proving and a stale index is reported as `nothing_found`. `preview_deploy` completes in under 1 second
for a 40-resource architecture, which is #101's own 20 ms pricing budget plus one indexed read of
`experiments` and one of `aws_connections`. `consume_confirmation` is one `UPDATE` on
`mcp_confirmations_confirmation_hash_key` and completes in under 5 ms. `canonical_plan_hash` is under
1 ms for a 500-resource plan, so recomputing it at execution time costs nothing worth optimising
away.

### Out of Scope

- Do not implement the deploy, destroy or load test tools themselves; `040-mcp-lifecycle-tools.md`
  owns all three and calls `consume_confirmation`
- Do not weaken or duplicate the TTL and budget guardrails from
  `docs/issues/epic-9-deploy/050-ttl-and-budget-reaper.md`. This issue reads `expires_at` and
  `budget_usd` and states them; the reaper remains the control that acts on them
- Do not require a confirmation for a destroy enqueued by the reaper. A safety net that needs an
  agent's token is not a safety net
- Do not add a confirmation to `apply_patch`. It spends nothing and destroys nothing, and a
  confirmation on every edit trains an operator to approve without reading
- Do not use elicitation for the confirmation. It depends on a client capability that may be absent
  and binds an answer to a question rather than to a plan
- Do not use MCP tool annotations as the enforcement mechanism. `destructive_hint` is set for the
  benefit of hosts that prompt, and the specification is explicit that a server may not rely on it
- Do not add a web UI for reviewing pending confirmations; the row is the record and Epic 11 (#12)
  owns any view of it
- Do not extend the confirmation contract to the architecture tools in
  `030-mcp-architecture-tools.md`
- Do not implement per-user spend aggregation across experiments. The unit that is confirmed and the
  unit that is destroyed are both one experiment, matching #113's reasoning about AWS Budgets

### Dependencies

Blocked by `docs/issues/epic-14-mcp/010-mcp-server-skeleton.md` and
`docs/issues/epic-14-mcp/020-mcp-authentication-and-scoping.md`. Blocked by #27 for `experiments`,
`expires_at` and `budget_usd`, #109 for
`aws_connections` and the assumed credentials `preview_destroy` queries with, #112 for the tag query
the destroy plan reuses, #113 for `MAX_EXPERIMENT_TTL_HOURS`, and #101 for the cost roll-up the deploy
plan states. Also depends on #70 for the ramp profile the load test plan describes.
`040-mcp-lifecycle-tools.md` is blocked by this issue.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
uv run --directory services/brain pytest -m integration
psql "$DATABASE_URL" -c "\d+ mcp_confirmations"
psql "$DATABASE_URL" -c "SELECT action, plan_hash, consumed_at, consumed_by_operation FROM mcp_confirmations ORDER BY created_at DESC"
```

Testing without a real AWS account: everything about the token - single use, plan binding, expiry,
replacement, the rate limit and the shared transaction - is exercised against live Postgres with the
AWS calls stubbed, because none of those properties involve AWS. The concurrency case is driven with
two connections redeeming the same token simultaneously, so the one-success guarantee is proven against
the real unique index and the real predicate rather than against a lock in Python. `preview_destroy`
replays recorded `GetResources` responses through `aws-sdk-client-mock` on the `apps/api` side, reusing
#112's fixtures so the plan and the sweep describe resources the same way. What cannot be proven
locally is that the ARNs a real account returns match the ones the plan listed; it is checked once per
release on the pre-release checklist by previewing a destroy of the fixture experiment in the sandbox
account and comparing the plan against the sweep report.

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
