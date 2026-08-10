---
title: '[brain] Token accounting against the monthly budget and a content-hash cache'
labels: tier:2, size:m, area:brain, epic:6-brain
---

### Epic

#7

### Context

#61 lets a user state a monthly token budget. Nothing counts against it, so today the number is
decoration and the failure mode it exists to prevent -- an agent loop quietly spending a user's own
API key -- is unguarded. Everything in this epic makes model calls: the profile agent, its repair
round, and the verifier's judge. They need one place that both counts and refuses.

**Refuse before the call, not after.** Recording usage after the fact tells a user what they already
cannot undo. The check and the write therefore happen in a single statement, so two requests that
arrive together cannot both observe the same under-budget total and both proceed. The estimate used
for the pre-flight check is deliberately pessimistic: characters divided by 3.5 plus the scale's
maximum output. It overshoots, which means a user is stopped slightly early rather than slightly
late, and the row is corrected with the real counts when the call returns.

**402 rather than 429.** A rate limit says come back shortly, and a client that reads
`Retry-After` will do exactly that. A month's budget will not free up on a retry, so the status has
to mean something a client will not paper over.

**The cache is keyed per user, and that is a deliberate cost.** Keying on content alone would let two
users share a cached response whenever their prompts hash the same, and for a tool that puts private
source code into prompts an identical hash means identical private source. The saving is not worth
owning that as a leak surface, so `user_id` is part of the key and cross-user deduplication is
rejected. What remains is still most of the benefit: re-running an analysis on an unchanged commit,
the agent's repair round re-sending an identical context, and the judge seeing the same span twice
all become free. The key also covers the prompt version and the profile schema version, because a
cache that survives a prompt change returns answers to a question no longer being asked.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TABLE llm_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider      text NOT NULL,
  model         text NOT NULL,
  reasoning     text NOT NULL,
  -- 'profile', 'profile-repair', 'judge'. Lets a user see which part of the
  -- product spent the budget rather than only that it is gone.
  purpose       text NOT NULL,
  estimated_tokens integer NOT NULL CHECK (estimated_tokens >= 0),
  input_tokens  integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_hit     boolean NOT NULL DEFAULT false,
  -- Generated rather than trigger-maintained so it can never disagree with
  -- created_at, and so the monthly sum can use one index.
  billing_month date NOT NULL GENERATED ALWAYS AS
    ((date_trunc('month', created_at AT TIME ZONE 'UTC'))::date) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_usage_user_month_idx ON llm_usage (user_id, billing_month);

CREATE TRIGGER llm_usage_set_updated_at
  BEFORE UPDATE ON llm_usage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE llm_response_cache (
  cache_key     text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider      text NOT NULL,
  model         text NOT NULL,
  reasoning     text NOT NULL,
  response      jsonb NOT NULL,
  input_tokens  integer NOT NULL,
  output_tokens integer NOT NULL,
  hit_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_hit_at   timestamptz
);

CREATE INDEX llm_response_cache_created_idx ON llm_response_cache (created_at);
```

The reservation is one statement, so the check cannot be separated from the write:

```sql
INSERT INTO llm_usage (user_id, provider, model, reasoning, purpose, estimated_tokens)
SELECT %(user_id)s, %(provider)s, %(model)s, %(reasoning)s, %(purpose)s, %(estimated)s
WHERE (
  SELECT coalesce(sum(input_tokens + output_tokens), 0)
  FROM llm_usage
  WHERE user_id = %(user_id)s
    AND billing_month = (date_trunc('month', now() AT TIME ZONE 'UTC'))::date
) + %(estimated)s <= %(budget)s
RETURNING id;
```

No row returned means the budget is spent.

```python
# services/brain/src/brain/llm/budget.py
class BudgetExceededError(RuntimeError):
    used_tokens: int
    budget_tokens: int
    resets_at: datetime


async def reserve(
    user_id: UUID, credential: ProviderCredential, purpose: str, estimated: int
) -> UUID:
    """Insert a reservation row or raise BudgetExceededError. Returns its id."""


async def settle(reservation_id: UUID, input_tokens: int, output_tokens: int) -> None:
    """Replace the estimate with the counts the provider reported."""


async def month_to_date(user_id: UUID) -> UsageSummary: ...
```

```python
# services/brain/src/brain/llm/cache.py
def cache_key(
    user_id: UUID,
    credential: ProviderCredential,
    scale: ReasoningScale,
    messages: Sequence[ModelMessage],
    prompt_version: str,
) -> str:
    """SHA-256 over a canonical JSON encoding of every argument, with sorted
    keys. PROFILE_SCHEMA_VERSION is folded in, so a schema bump invalidates
    every entry without a manual purge."""


async def lookup(key: str) -> CachedResponse | None: ...
async def store(key: str, credential: ProviderCredential, response: object,
                input_tokens: int, output_tokens: int) -> None: ...
async def prune(older_than: timedelta) -> int: ...
```

```python
# services/brain/src/brain/llm/metering.py
class MeteredRunner:
    async def run[D, T](
        self, agent: Agent[D, T], prompt: str, *, deps: D, purpose: str, user_id: UUID
    ) -> T:
        """Cache lookup, reserve, run, settle, store. Every model call in this
        service goes through here; nothing calls `agent.run` directly."""
```

A cache hit records a usage row with `cache_hit = true` and zero tokens, so the audit trail shows
the call happened and shows that it cost nothing.

```
402 {"error": "budget_exceeded", "usedTokens": n, "budgetTokens": n, "resetsAt": "..."}
```

### Files

- CREATE `db/migrations/<timestamp>_llm_usage_and_response_cache.sql`
- CREATE `services/brain/src/brain/llm/budget.py`
- CREATE `services/brain/src/brain/llm/cache.py`
- CREATE `services/brain/src/brain/llm/metering.py`
- MODIFY `services/brain/src/brain/profile/agent.py` - run through `MeteredRunner`
- MODIFY `services/brain/src/brain/profile/judge.py` - run through `MeteredRunner`
- MODIFY `services/brain/src/brain/routes/profile.py` - map `BudgetExceededError` to 402
- CREATE `services/brain/tests/test_budget.py`
- CREATE `services/brain/tests/test_cache.py`
- CREATE `services/brain/tests/test_metering.py`

### Acceptance Criteria

- [ ] The migration applies, rolls back, and reapplies on `pgvector/pgvector:pg17`
- [ ] Two concurrent reservations that would jointly exceed the budget leave exactly one accepted
- [ ] A call that would exceed the budget raises before any request reaches the provider
- [ ] `billing_month` is derived from `created_at` in UTC and cannot be written directly
- [ ] Usage from the previous calendar month does not count towards this month's total
- [ ] A settled row replaces the estimate with the counts the provider reported
- [ ] A second identical run makes no provider call and records a usage row with `cache_hit = true` and zero tokens
- [ ] Changing the reasoning scale, the model, or `PROFILE_SCHEMA_VERSION` produces a different cache key
- [ ] A cached response is never returned to a different user, even for a byte-identical prompt
- [ ] Deleting a user removes their usage rows and their cache entries
- [ ] No module outside `metering.py` calls `agent.run`, asserted by a test that scans the source tree

### Required Tests

- `test_rejects_a_call_that_would_exceed_the_monthly_budget`
- `test_concurrent_reservations_cannot_both_pass_the_same_check`
- `test_previous_month_usage_does_not_count_towards_this_month`
- `test_settle_replaces_the_estimate_with_reported_counts`
- `test_cache_hit_records_zero_tokens`
- `test_cache_key_changes_with_the_reasoning_scale`
- `test_cache_key_changes_with_the_profile_schema_version`
- `test_never_returns_another_users_cached_response`
- `test_no_module_outside_metering_calls_agent_run`

### Performance Budget

A cache lookup returns in under 5ms at 100k rows, and the reservation statement in under 10ms, both
measured on the CI runner with `EXPLAIN ANALYZE` recorded in the pull request. Accounting adds under
20ms to a model call end to end. A repeat run of the fixture profile makes zero provider calls and
completes in under 2 seconds.

### Out of Scope

- Do not add a currency estimate; tokens are what #61 stores and what providers report
- Do not build a scheduled pruning job; `prune()` is exposed and #28 owns scheduling
- Do not add per-repository or per-organisation budgets
- Do not change the `user_settings` or `llm_credentials` tables from #61
- Do not add a usage dashboard; this issue provides `month_to_date` and stops there

### Dependencies

Blocked by #22 and #61, and by the registry in
`docs/issues/epic-6-brain/020-provider-registry.md`.

### Verification

```bash
pnpm db:migrate
pnpm db:rollback && pnpm db:migrate
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
uv run --directory services/brain pytest -m integration
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
