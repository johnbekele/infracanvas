---
title: '[infra] Join client and server metrics into measured SLIs'
labels: tier:2, size:m, area:infra, area:api, epic:10-loadtest
---

### Epic

#11

### Context

Neither side of a load test can produce the numbers this epic owes on its own. k6 knows what a caller
experienced, including connection setup, queueing at the load balancer, and the requests that never
reached the application at all; CloudWatch knows where the time went and what saturated first. The
report needs both, so the two series have to be put on one timeline.

Joining them by wall-clock timestamp naively is wrong, in two separate ways that both push the answer
in a flattering direction.

The first is attribution rather than clock error. Fargate tasks use the Amazon Time Sync Service, so
raw clock skew is small, but k6 stamps a sample when the request starts while a load balancer
attributes a request to the period in which it completed. Under load, when a request takes 800 ms,
those are different minutes. The runner therefore issues a marker request at the start and end of the
run, the join measures the offset from the marker rather than assuming the clocks agree, and it works
only in whole 60-second buckets that lie entirely inside the run. The first and last buckets are
discarded: they contain a partially observed period on one side and a fully observed one on the other,
and averaging across that boundary reliably understates load and overstates throughput.

The second is scrape delay. CloudWatch datapoints for load balancer and database metrics appear with
a lag and are backfilled, so a `GetMetricStatistics` call issued the moment a run ends returns fewer
datapoints than the identical call five minutes later. A join that reads once produces an SLI computed
over holes, and the holes look like idle capacity. The join therefore polls each series until two
consecutive reads sixty seconds apart return identical datapoints, or a ten-minute deadline passes; a
series that never settles is named in `incomplete` and the SLI is marked `partial` rather than
published as measured.

One arithmetic rule is stated here because it is the most common way a load-test report becomes
fiction: percentiles do not average. The client p99 is computed from the raw k6 samples over the whole
window, and the server-side p99 is requested from CloudWatch as an extended statistic over the whole
window. Taking the mean of per-minute p99s is never done, and the code says so where it would be
tempting.

Spec: `docs/DATABASE.md`

### Contract

```typescript
// apps/api/src/lib/loadtest/window.ts
export interface MetricWindow {
  /** Whole-minute boundaries, inner buckets only. */
  from: Date;
  to: Date;
  droppedBuckets: number;
  /** Measured from the marker requests, applied to the client series. */
  clockOffsetMs: number;
}

export function resolveWindow(run: LoadTestRun, markers: MarkerSample[]): MetricWindow;
```

```typescript
// apps/api/src/lib/loadtest/client-metrics.ts
export interface ClientBucket {
  startedAt: Date;
  requests: number;
  failures: number;
  achievedRps: number;
}

export interface ClientMetrics {
  totalRequests: number;
  failedRequests: number;
  /** From raw samples across the whole window, never a mean of bucket percentiles. */
  durationMs: { p50: number; p95: number; p99: number; max: number };
  perPath: Record<string, { requests: number; p99Ms: number; errorRate: number }>;
  perStage: StageResult[];
  buckets: ClientBucket[];
}

/** Streams k6 JSON lines; retains reservoirs and counters only, never the samples. */
export function parseK6Samples(source: Readable): Promise<ClientMetrics>;
```

```typescript
// apps/api/src/lib/loadtest/server-metrics.ts
export interface ServerMetrics {
  albTargetResponseTimeMs: { p50: number; p99: number } | null;
  alb5xx: number | null;
  albRejectedConnections: number | null;
  ecsCpuUtilisationPct: { mean: number; max: number } | null;
  rdsConnections: { max: number } | null;
  /** Metric ids whose datapoints never stopped changing before the deadline. */
  incomplete: string[];
}

/** Polls until each series settles, or for at most `deadlineMs` (default 600_000). */
export function fetchServerMetrics(
  deployment: Deployment,
  window: MetricWindow,
  deadlineMs?: number
): Promise<ServerMetrics>;
```

```typescript
// apps/api/src/lib/loadtest/join.ts
export interface MeasuredSli {
  runId: string;
  window: MetricWindow;
  p99Ms: number;
  p50Ms: number;
  errorRate: number;
  /** Highest stage whose error rate and p99 both stayed inside the SLO. */
  sustainableRps: number;
  kneePoint: { stageIndex: number; targetRps: number; achievedRps: number } | null;
  confidence: 'measured' | 'partial';
}

export class InterruptedRunError extends Error {}

export function joinMetrics(
  client: ClientMetrics,
  server: ServerMetrics,
  profile: RampProfile
): MeasuredSli;

/** Persists both raw summaries and the joined SLI, so the join can be recomputed. */
export function storeMetrics(runId: string, m: StoredMetrics): Promise<void>;
```

```sql
CREATE TABLE loadtest_metrics (
  run_id          uuid PRIMARY KEY REFERENCES loadtest_runs (id) ON DELETE CASCADE,
  window_from     timestamptz NOT NULL,
  window_to       timestamptz NOT NULL,
  clock_offset_ms integer NOT NULL,
  dropped_buckets integer NOT NULL,
  client          jsonb NOT NULL,
  server          jsonb NOT NULL,
  sli             jsonb NOT NULL,
  confidence      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (window_to > window_from),
  CHECK (confidence IN ('measured', 'partial'))
);
```

### Files

- CREATE `db/migrations/<timestamp>_loadtest_metrics.sql`
- CREATE `apps/api/src/lib/loadtest/window.ts`
- CREATE `apps/api/src/lib/loadtest/client-metrics.ts`
- CREATE `apps/api/src/lib/loadtest/server-metrics.ts`
- CREATE `apps/api/src/lib/loadtest/join.ts`
- CREATE `apps/api/src/lib/db/loadtest-metrics.ts`
- CREATE `apps/api/src/lib/loadtest/join.test.ts`
- CREATE `apps/api/src/lib/loadtest/client-metrics.test.ts`
- CREATE `apps/api/src/lib/db/loadtest-metrics.integration.test.ts`
- CREATE `apps/api/src/lib/loadtest/fixtures/samples-12-stage.jsonl` - recorded k6 output

### Acceptance Criteria

- [ ] The join uses only whole 60-second buckets entirely inside the run, and reports how many it dropped
- [ ] The client series is shifted by the offset measured from the marker requests, not by an assumed zero
- [ ] Each server series is polled until two consecutive reads return identical datapoints, or until the deadline
- [ ] A series still changing at the deadline is named in `incomplete` and the SLI is marked `partial`
- [ ] A `partial` SLI is stored with that confidence rather than presented as measured
- [ ] p99 is computed from raw client samples; no code path averages per-bucket percentiles
- [ ] `sustainableRps` is the highest stage whose error rate and p99 both stayed inside the SLO
- [ ] `achievedRps` is reported next to `targetRps`, so a stage the generator could not reach is visible rather than counted as capacity
- [ ] Joining a run with status `interrupted` raises `InterruptedRunError` and writes no row
- [ ] Recomputing the join from the stored `client` and `server` documents yields the same SLI

### Required Tests

- `discards the partial bucket at each end of the window`
- `applies the clock offset measured from the marker requests`
- `polls the server series until it stops changing`
- `marks the sli partial when a series never settles`
- `computes p99 from raw samples rather than averaging bucket percentiles`
- `selects the highest stage inside the slo as sustainable rps`
- `reports achieved rps below target when the generator fell short`
- `refuses to join metrics for an interrupted run`
- `is deterministic: the same stored documents yield the same sli`

### Performance Budget

Parsing a 500 MB recorded sample file completes in under 60 seconds with peak resident set under
512 MB, sampled from `process.memoryUsage().rss` during the test, because samples are streamed and
only counters and reservoirs are retained. `fetchServerMetrics` issues at most 40 CloudWatch calls per
run, counted in the unit test with a stubbed client.

### Out of Scope

- Do not build the predicted-versus-measured report; that is `docs/issues/epic-10-loadtest/040-predicted-versus-measured-report.md`
- Do not create CloudWatch alarms, dashboards, or metric filters
- Do not change the runner, the task definition, or the ramp profile
- Do not add an agent or sidecar to the deployed application to collect metrics
- Do not adjust the prediction models even where the measurement plainly disagrees with them

### Dependencies

Blocked by #27, and by the runner in `docs/issues/epic-10-loadtest/020-fargate-spot-runner.md`.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test:integration
psql "$DATABASE_URL" -c "SELECT confidence, sli->>'p99Ms', sli->>'sustainableRps' FROM loadtest_metrics"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
