---
title: '[infra] Report predicted against measured and feed the error back into the models'
labels: tier:2, size:m, area:infra, area:api, epic:10-loadtest
---

### Epic

#11

### Context

This is the issue that decides what the product is. Drawing an architecture and printing a latency and
a cost next to it is a diagram tool with confident typography; the numbers become engineering when
somebody deploys the thing, measures it, states how wrong the prediction was, and uses that error to
make the next prediction better. Everything else in this repository is in service of closing that loop,
and this issue closes it. If the loop is skipped, the honest description of the product changes, and so
should the marketing.

The report therefore states error rather than hiding it. Predicted and measured are both retained for
every metric, and the signed relative error is printed. A metric with no measurement is reported as
unmeasured, never as agreeing: silence is the failure mode that makes a calibration report useless,
because a model that is never contradicted looks perfect.

The correction step is deliberately timid. Refitting the predictors on every run was rejected: a single
run includes a cold cache, a container image pulled for the first time, and whatever the noisy
neighbour on that Spot capacity was doing, and letting one such run rewrite the model poisons every
future estimate for architectures it never tested. Instead the corrections are per-metric and
per-component-class multiplicative factors, updated with an exponentially weighted average, clipped to
the range 0.5 to 2.0, and withheld from the predictor until at least three samples support them. A
factor that wants to move outside that range is a modelling bug rather than a calibration signal, and
the clip is recorded so the bug can be found.

Overwriting the prediction with the measurement was also rejected, though it would make every report
green. It destroys the error signal, which is the only thing here with information in it.

"Measurably improves" is given an executable definition rather than a claim. Recorded runs are held as
fixtures, split into a fitting set and a held-out set, and a replay test asserts that the mean absolute
relative error for p99 on the held-out runs falls after one calibration cycle and never rises. That
test is the epic's exit criterion, expressed as something CI can fail.

Spec: `docs/DATABASE.md`

### Contract

```typescript
// packages/core/src/prediction/calibration.ts
export type PredictionMetric = 'p50_ms' | 'p99_ms' | 'sustainable_rps' | 'monthly_usd';

export interface MetricComparison {
  metric: PredictionMetric;
  predicted: number;
  /** null means the run produced no measurement for this metric. */
  measured: number | null;
  absoluteError: number | null;
  /** Signed: (measured - predicted) / predicted. Negative means the model was pessimistic. */
  relativeError: number | null;
  tolerance: number;
  status: 'within_tolerance' | 'outside_tolerance' | 'unmeasured';
}

export interface CalibrationReport {
  experimentId: string;
  runId: string;
  irVersion: string;
  modelVersion: string;
  comparisons: MetricComparison[];
  confidence: 'measured' | 'partial';
  /** Stated caveats, for example a cold start inside the first stage. */
  notes: string[];
}

export function buildCalibrationReport(input: BuildReportInput): CalibrationReport;
export function renderCalibrationReport(report: CalibrationReport): string; // markdown artifact
```

```typescript
// apps/api/src/lib/prediction/corrections.ts
export interface CorrectionUpdate {
  metric: PredictionMetric;
  componentClass: string; // 'alb' | 'ecs_service' | 'rds_postgres' | ...
  observedRatio: number; // measured / predicted
  nextFactor: number; // after the EWMA update and the clip
  clipped: boolean;
}

export const CORRECTION_ALPHA = 0.25;
export const CORRECTION_MIN = 0.5;
export const CORRECTION_MAX = 2.0;
export const MIN_SAMPLES_BEFORE_APPLYING = 3;

/** Returns an empty array for a `partial` SLI: an incomplete measurement corrects nothing. */
export function proposeCorrections(report: CalibrationReport): CorrectionUpdate[];
export function applyCorrections(runId: string, u: readonly CorrectionUpdate[]): Promise<void>;
/** Factors the predictor may use: sample_count >= MIN_SAMPLES_BEFORE_APPLYING only. */
export function activeCorrections(): Promise<Map<string, number>>;
export function revertCorrection(
  runId: string,
  metric: PredictionMetric,
  componentClass: string
): Promise<void>;
```

The update is `next = clip(current * (1 - alpha) + observedRatio * alpha, 0.5, 2.0)`.

```sql
CREATE TABLE prediction_observations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES loadtest_runs (id) ON DELETE CASCADE,
  metric          text NOT NULL,
  component_class text NOT NULL,
  predicted       numeric NOT NULL,
  measured        numeric NOT NULL,
  relative_error  numeric NOT NULL,
  model_version   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, metric, component_class)
);

CREATE TABLE prediction_corrections (
  metric          text NOT NULL,
  component_class text NOT NULL,
  factor          numeric NOT NULL,
  sample_count    integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric, component_class),
  CHECK (factor BETWEEN 0.5 AND 2.0)
);

-- Every applied update, so a bad calibration can be traced to the run that caused it.
CREATE TABLE prediction_correction_audit (
  id              bigserial PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES loadtest_runs (id) ON DELETE CASCADE,
  metric          text NOT NULL,
  component_class text NOT NULL,
  previous_factor numeric NOT NULL,
  new_factor      numeric NOT NULL,
  clipped         boolean NOT NULL,
  applied_at      timestamptz NOT NULL DEFAULT now()
);
```

The rendered report is stored with `putArtifact({ kind: 'loadtest_report', path: 'reports/predicted-vs-measured.md' })`,
so it lives with the experiment it describes.

```
GET /experiments/:id/loadtest/report -> 200 { report } | 404
```

### Files

- CREATE `db/migrations/<timestamp>_prediction_calibration.sql`
- CREATE `packages/core/src/prediction/calibration.ts`
- CREATE `packages/core/src/prediction/calibration.test.ts`
- CREATE `apps/api/src/lib/prediction/corrections.ts`
- CREATE `apps/api/src/lib/prediction/corrections.integration.test.ts`
- CREATE `apps/api/src/lib/prediction/calibration-replay.integration.test.ts`
- CREATE `apps/api/src/lib/prediction/fixtures/runs/` - six recorded runs, three fitting and three held out
- CREATE `apps/api/src/routes/experiments/loadtest-report.ts`
- MODIFY `packages/core/src/index.ts` - export the calibration module

### Acceptance Criteria

- [ ] The report states predicted, measured, and signed relative error for p50, p99, sustainable RPS, and monthly cost
- [ ] A metric with no measurement is reported with status `unmeasured` rather than treated as agreeing
- [ ] The measurement is never written over the prediction; both remain readable for every run
- [ ] A correction factor outside 0.5 to 2.0 is clipped and the clip is recorded in the audit table
- [ ] A factor with fewer than three supporting samples is stored but excluded from `activeCorrections`
- [ ] A `partial` SLI produces a report and no corrections
- [ ] Every applied correction writes an audit row naming the run, the previous factor, and the new factor
- [ ] `revertCorrection` restores the previous factor from the audit row
- [ ] Held-out mean absolute relative error for p99 falls by at least 10 per cent relative after one calibration cycle over the recorded fixtures, and never rises
- [ ] The rendered report is stored as a `loadtest_report` artifact against the experiment

### Required Tests

- `states predicted measured and signed error for every metric`
- `marks a metric unmeasured when the run produced no value for it`
- `keeps the prediction after the measurement arrives`
- `clips a correction factor to the allowed range and records the clip`
- `withholds a factor with fewer than three samples from the predictor`
- `proposes no corrections from a partial sli`
- `reverts a correction to the previous factor from the audit row`
- `reduces held out p99 error after one calibration cycle`
- `never increases held out error for any metric after a cycle`

### Performance Budget

Building and rendering the report for one run completes in under 500 ms, measured by the vitest case.
The calibration replay over six recorded runs completes in under 30 seconds under
`pnpm --filter @infracanvas/api test:integration`, so it can stay in Gate 3 rather than becoming a
nightly-only check.

### Out of Scope

- Do not modify the cost or latency predictors themselves (Epic 7, #8); this issue supplies the
  correction table they read and nothing more
- Do not introduce a modelling framework or a regression library; the update rule is four lines of arithmetic
- Do not calibrate per request, per component instance, or per region; the unit is metric and component class
- Do not change the metrics join or the runner to make a comparison come out better
- Do not add a UI for the report beyond the endpoint; the web view belongs to Epic 11 (#12)

### Dependencies

Blocked by #27, by the prediction models from Epic 7 (#8), and by the join in
`docs/issues/epic-10-loadtest/030-metrics-join.md`.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test:integration
psql "$DATABASE_URL" -c "SELECT metric, component_class, factor, sample_count FROM prediction_corrections ORDER BY metric"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
