---
title: '[infra] Per-experiment TTL and budget cap with a reaper that destroys on breach'
labels: tier:1, size:m, area:infra, epic:9-deploy
---

### Epic

#10

### Context

Every experiment this platform deploys is a meter running in somebody's AWS account, started by a
machine on the strength of a natural-language request. The guardrail cannot be a warning in the
interface, because the failure mode is precisely that nobody is looking. #27 already stores `expires_at`
and `budget_usd` on every experiment and indexes the expiry; this issue is the process that acts on
them.

**Time is the guarantee, money is the second net.** A TTL needs no AWS data: the row says when the
experiment expires, the clock says what time it is, and the destroy path from
`docs/issues/epic-9-deploy/040-one-click-destroy.md` does the rest. Spend is not like that. Cost
Explorer data lags by up to a day, and cost allocation by tag only works after somebody activates the
tag key in the payer account, which is a manual step in a console we do not control. A budget cap built
on that is a cap that silently does nothing for the first 24 hours of an account's life and possibly
forever. So the budget check is real but secondary, and the TTL is what actually bounds the damage.
Presenting the budget as the primary control would be the kind of guardrail that reads well and stops
nothing.

**Absent data is not zero spend.** If the tag key was never activated, `GetCostAndUsage` returns no
groups. Read carelessly that is "this experiment cost nothing", which would mean the cap never fires;
read carelessly the other way it is "no data, destroy everything". Neither is right: the reaper treats
missing or stale cost data as _unknown_, makes no budget decision, records a warning naming the account,
and leaves the TTL to do its job.

**Every destruction leaves a reason.** An environment disappearing without explanation is
indistinguishable from a bug in the reaper. Before enqueuing a destroy, the reaper writes a `cost_report`
artifact - a kind #27 already defines - holding the decision, the observed spend, the budget, and the
expiry it compared against. That is what a user reads afterwards, and what tells us whether a reap was
correct.

**One request per account per hour, not one per experiment.** Cost Explorer charges per request. Grouping
by the experiment tag returns every experiment's spend in a single response, which keeps the cost of
enforcing a budget from being a noticeable fraction of the budget.

Spec: `docs/AWS.md`, `docs/DATABASE.md`

### Contract

```ts
// apps/api/src/lib/reaper/tags.ts
/** Load-bearing: the boundary requires it at create time and cost grouping keys on it. */
export const EXPERIMENT_TAG = 'infracanvas:experiment-id';
export const MANAGED_TAG = 'infracanvas:managed-by';

// apps/api/src/lib/reaper/cost.ts
export interface TaggedSpend {
  readonly experimentId: string | null; // null is spend attributed to no experiment
  readonly amountUsd: number;
}
export interface SpendSnapshot {
  readonly spend: readonly TaggedSpend[];
  /** End of the period AWS has data for. Null when the tag key is not activated. */
  readonly dataThrough: Date | null;
  readonly tagActivated: boolean;
}
/** One GetCostAndUsage call grouped by the experiment tag, for the whole account. */
export function fetchSpendByExperiment(
  credentials: AwsCredentials,
  since: Date
): Promise<SpendSnapshot>;

// apps/api/src/lib/reaper/reaper.ts
export type ReapReason = 'ttl_expired' | 'ttl_exceeds_maximum' | 'budget_exceeded';
export interface ReapDecision {
  readonly experimentId: string;
  readonly reason: ReapReason;
  readonly observedUsd: number | null;
  readonly budgetUsd: number;
  readonly expiresAt: Date;
}
export interface ReapSummary {
  readonly decisions: readonly ReapDecision[];
  readonly enqueued: number;
  readonly skipped: readonly { experimentId: string; why: string }[];
  readonly warnings: readonly string[];
  readonly durationMs: number;
}
export function planReap(now: Date): Promise<ReapDecision[]>;
export function runReaperSweep(now: Date, options: { dryRun: boolean }): Promise<ReapSummary>;

// apps/api/src/lib/reaper/schedule.ts
export function startReaper(): void;
/** Stops the timer and waits for a sweep in progress. */
export function stopReaper(): Promise<void>;
```

Sweep behaviour:

1. Take `pg_try_advisory_lock(REAPER_LOCK_KEY)` and return immediately if another instance holds it, so
   running two API processes does not enqueue two destroys per experiment.
2. TTL: `listExpiredExperiments(now)` from #27. Every result is a `ttl_expired` decision, with no AWS
   call and no condition attached.
3. TTL sanity: an experiment whose `expires_at` is more than `MAX_EXPERIMENT_TTL_HOURS` (default 24)
   after its `created_at` is treated as `ttl_exceeds_maximum` and reaped now. An over-long TTL is a bug
   or an abuse, and the platform's promise is bounded regardless of what was written to the row.
4. Budget, at most once per `BUDGET_CHECK_INTERVAL_MS` (default 3600000) per connected account: assume
   the connection, `fetchSpendByExperiment` since the oldest active experiment's `created_at`, and raise
   `budget_exceeded` where `observedUsd > budget_usd`. Skip every budget decision when `tagActivated` is
   false or `dataThrough` is older than 36 hours, recording a warning instead.
5. Spend returned with a null experiment id becomes a warning naming the amount, because untagged spend
   means the tagging guarantee has a hole worth knowing about.
6. For each decision: write the `cost_report` artifact, then enqueue `deploy.destroy` unless the
   experiment is already `destroying` or `destroyed`, or has already been enqueued
   `REAPER_MAX_ATTEMPTS` (default 3) times. Past that, log once at error level and stop, so an
   undeletable stack cannot become an infinite loop of builds.
7. Under `REAPER_DRY_RUN`, everything runs and the artifact is written, but nothing is enqueued.

The reaper reads `experiments.expires_at` rather than a tag on the resources. An `infracanvas:expires-at`
tag is deliberately not emitted: extending a TTL cannot rewrite tags on already-created resources, and a
tag that disagrees with the database is worse than no tag at all.

`AWS_COST_EXPLORER_REGION` is declared in `apps/api/src/lib/env.ts` with a default carrying a trailing
`infracanvas-allow: no-hardcoded-region` comment, because the Cost Explorer endpoint exists in exactly
one region per partition.

### Files

- CREATE `apps/api/src/lib/reaper/tags.ts`
- CREATE `apps/api/src/lib/reaper/cost.ts`
- CREATE `apps/api/src/lib/reaper/reaper.ts`
- CREATE `apps/api/src/lib/reaper/schedule.ts`
- CREATE `apps/api/src/lib/reaper/cost.test.ts`
- CREATE `apps/api/src/lib/reaper/reaper.test.ts`
- CREATE `apps/api/src/lib/reaper/reaper.integration.test.ts`
- CREATE `apps/api/src/lib/reaper/__fixtures__/cost-under-budget.json`
- CREATE `apps/api/src/lib/reaper/__fixtures__/cost-over-budget.json`
- CREATE `apps/api/src/lib/reaper/__fixtures__/cost-tag-not-activated.json`
- CREATE `apps/api/src/lib/reaper/__fixtures__/cost-stale-and-untagged.json`
- MODIFY `apps/api/package.json` - add `@aws-sdk/client-cost-explorer`
- MODIFY `apps/api/src/lib/env.ts` - add `REAPER_INTERVAL_MS`, `REAPER_DRY_RUN`,
  `BUDGET_CHECK_INTERVAL_MS`, `MAX_EXPERIMENT_TTL_HOURS`, `REAPER_MAX_ATTEMPTS`,
  `AWS_COST_EXPLORER_REGION`
- MODIFY `apps/api/src/index.ts` - start the reaper and stop it during shutdown
- MODIFY `apps/api/.env.example` - document the new variables
- MODIFY `docs/AWS.md` - record that activating the cost allocation tag is a manual step in the payer
  account, and what the budget cap does until it happens

### Acceptance Criteria

- [ ] An experiment past `expires_at` is enqueued for destroy with reason `ttl_expired` and no AWS call
- [ ] An experiment whose TTL exceeds the maximum is reaped even though its `expires_at` is in the future
- [ ] An experiment whose observed spend exceeds its budget is enqueued with reason `budget_exceeded`
- [ ] A Cost Explorer response with no groups produces a warning and no budget decision, never a reap
- [ ] Cost data older than 36 hours produces a warning and no budget decision
- [ ] Spend attributed to no experiment is reported as a warning naming the amount
- [ ] A `cost_report` artifact recording the decision is written before any destroy is enqueued
- [ ] An experiment already `destroying` or `destroyed` is skipped rather than enqueued again
- [ ] A repeatedly failing destroy stops being enqueued after `REAPER_MAX_ATTEMPTS`
- [ ] `REAPER_DRY_RUN` writes decisions and artifacts but enqueues nothing
- [ ] Two API instances sweeping concurrently enqueue each destroy once
- [ ] At most one Cost Explorer request per account per `BUDGET_CHECK_INTERVAL_MS`
- [ ] `stopReaper` waits for a sweep in progress rather than abandoning it mid-write

### Required Tests

- `enqueues a destroy for an experiment past its ttl`
- `reaps an experiment whose ttl exceeds the maximum`
- `enqueues a destroy when observed spend exceeds the budget`
- `treats an empty cost response as unknown rather than zero`
- `makes no budget decision on stale cost data`
- `warns about spend attributed to no experiment`
- `writes a cost report artifact before enqueuing`
- `skips an experiment already being destroyed`
- `stops enqueuing after the retry limit`
- `dry run enqueues nothing`
- `a concurrent sweep enqueues each destroy once`
- `issues at most one cost explorer request per interval`

### Performance Budget

A sweep with 1000 active experiments across 50 connected accounts completes in under 10 seconds,
measured by `ReapSummary.durationMs` in the integration test, using one indexed query against
`experiments_expiry_idx` plus at most one Cost Explorer request per account per hour. Cost Explorer is
charged per request, so the hourly cadence caps the enforcement cost at roughly 0.24 US dollars per
account per day. An idle reaper adds under 1% CPU, matching the worker's budget in #29.

### Out of Scope

- Do not implement the destroy path; this issue decides and enqueues, and
  `docs/issues/epic-9-deploy/040-one-click-destroy.md` performs
- Do not add columns to `experiments` or `deployments`; the decision record is a `cost_report` artifact
- Do not emit an `infracanvas:expires-at` tag, which cannot be kept in step with an extended TTL
- Do not use AWS Budgets or a billing alarm; they notify per account, and the unit that has to be
  destroyed is an experiment
- Do not implement pre-deploy cost estimation or refuse a deploy on its estimate; that reads the
  prediction epic's model
- Do not reap `draft` experiments, which have provisioned nothing; #27's query already excludes them

### Dependencies

Blocked by #27 for `expires_at`, `budget_usd`, `listExpiredExperiments`, and the `cost_report` artifact
kind, #28 for the queue, and #29 for the worker. Also blocked by
`docs/issues/epic-9-deploy/040-one-click-destroy.md`, whose handler it enqueues, and by the
`infracanvas:experiment-id` tag applied by `docs/issues/epic-8-codegen/010-pulumi-python-emitter.md`
and required at create time by `docs/issues/epic-9-deploy/020-bootstrap-stack.md`.

### Verification

```bash
pnpm --filter @infracanvas/api test
pnpm db:migrate
pnpm --filter @infracanvas/api test:integration
REAPER_DRY_RUN=true REAPER_INTERVAL_MS=5000 pnpm --filter @infracanvas/api dev
psql "$DATABASE_URL" -c "SELECT kind, path FROM artifacts WHERE kind = 'cost_report'"
```

Testing without a real AWS account: the TTL path needs no AWS at all and is tested against live Postgres
with `listExpiredExperiments`, including the boundary cases of an experiment expiring during the sweep
and one already `destroying`. Cost Explorer is not available in LocalStack's community edition, so
`GetCostAndUsage` is replayed from four recorded responses captured in the sandbox account: under
budget, over budget, tag key not activated, and a response that is both stale and carries untagged
spend. The enqueue path asserts against the real queue tables with the destroy handler stubbed, so
idempotency and the retry limit are exercised without starting builds. What cannot be proven locally is
that AWS attributes spend to our tag at all, since that depends on cost allocation tag activation and on
a day of billing latency; it is confirmed once per release by deploying a fixture experiment with a
one-dollar budget into the sandbox account, waiting for cost data to appear, and observing the reap,
recorded on the pre-release checklist in `docs/AWS.md`.

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
