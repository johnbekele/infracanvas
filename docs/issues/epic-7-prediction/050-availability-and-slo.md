---
title: '[ir] Series-parallel availability model and derived SLO proposals'
labels: tier:2, size:m, area:ir, epic:7-prediction
---

### Epic

#8

### Context

Availability is the prediction users most often get wrong on their own, in both directions. A single
EC2 instance behind a load balancer feels highly available because there is a load balancer, and a
three-AZ deployment gets described as five nines because someone multiplied out independent failure
probabilities. This issue computes the number from the architecture and the SLAs AWS actually
publishes, and then turns it into an SLO the team can commit to.

The structure is series-parallel. Everything on the request path is in series, so its availabilities
multiply and the result is worse than the worst component -- which is the useful half of the model,
because it makes visible that adding a cache in front of a database lowers availability unless the
application can survive the cache being gone. Replicas across availability zones are in parallel, so
the architecture survives while any one of them stands.

**Parallel replicas are not independent, and the model says so.** The textbook `1 - (1 - a)^3` gives
a three-AZ deployment about eight nines, which is a number nobody has ever observed, because a
control plane problem or a region-wide event takes all three at once. A common-cause fraction is
therefore an explicit assumption, `availability.azCorrelation`, defaulting to 0.1: a tenth of
failures are modelled as hitting every replica together. Anyone who thinks that figure is wrong can
change it and see the result move, which is better than a formula that is precisely wrong and
unarguable.

**A published SLA beats a computed one.** AWS publishes separate commitments for several
configurations -- single-AZ and Multi-AZ RDS are not the same number -- and where a commitment exists
for the exact configuration, the model uses it and does not compute. Deriving 99.9975% for a
deployment AWS will only stand behind at 99.95% produces a figure that cannot be defended in an
incident review, and the whole point of the exercise is to produce figures that can be.

The SLO proposals fall out of that. The proposed target is the first rung of the standard ladder at
or below the modelled availability, never above it, because an SLO the architecture cannot meet on a
perfect day is a commitment to fail. Each proposal carries the SLI that measures it, named down to
the CloudWatch metric, so the target is checkable rather than aspirational.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```typescript
// packages/core/src/prediction/availability/slas.ts
export interface ServiceSla {
  serviceId: string;
  /** The exact configuration the commitment covers, for example `multi-az`. */
  configuration: string;
  /** Monthly uptime commitment as a fraction, for example 0.9995. */
  monthlyUptime: number;
  scope: 'global' | 'regional' | 'zonal';
  source: string;
  retrievedAt: string;
}

export const AWS_SLAS: ServiceSla[];
```

```typescript
// packages/core/src/prediction/availability/index.ts
export const MINUTES_PER_MONTH = 43_200; // 30 days, the window AWS SLAs use
export const DEFAULT_AZ_CORRELATION = 0.1;
export const SLO_LADDER = [0.99, 0.995, 0.999, 0.9995, 0.9999] as const;

export interface AvailabilityNode {
  resourceId: string;
  serviceId: string;
  configuration: string;
  availability: number;
  /** `published` when an SLA covers this configuration exactly. */
  basis: 'published' | 'modelled';
  azCount: number;
}

export interface AvailabilityReport {
  compositeAvailability: number;
  downtimeMinutesPerMonth: number;
  /** Resource id with the lowest availability on the path. */
  weakest: string;
  nodes: AvailabilityNode[];
  /** Resources with no published SLA and no modelled value. */
  unmodelled: string[];
}

export function availability(
  architecture: Resource[],
  ctx: AvailabilityContext
): Prediction<AvailabilityReport>;
```

```
series:    a = product(a_i)
parallel:  a = 1 - [ (1 - c) * product(1 - a_i) + c * (1 - min(a_i)) ]
           where c is availability.azCorrelation
published: when AWS_SLAS has an entry for (serviceId, configuration), that value
           is used and neither formula runs
```

```typescript
// packages/core/src/prediction/availability/slo.ts
export interface SliDefinition {
  name: string;
  description: string;
  /** CloudWatch metric expression for the numerator. */
  goodEvents: string;
  totalEvents: string;
}

export interface SloProposal {
  objective: 'availability' | 'latency';
  target: number;
  unit: 'fraction' | 'ms';
  window: '30d';
  errorBudgetMinutes: number;
  sli: SliDefinition;
  /** Why this rung and not the next one up. */
  rationale: string;
}

export function proposeSlos(
  report: AvailabilityReport,
  latency: PathLatency
): Prediction<SloProposal[]>;
```

The two SLIs, named to metrics that exist:

```
availability  good  = RequestCount - HTTPCode_ELB_5XX_Count - HTTPCode_Target_5XX_Count
              total = RequestCount                              (AWS/ApplicationELB)
latency       good  = count of TargetResponseTime <= the p95 target from the latency model
              total = RequestCount                              (AWS/ApplicationELB)
```

A 4xx is a good event: the service answered correctly that the request was wrong, and counting it
against the error budget makes a client bug look like an outage.

### Files

- CREATE `packages/core/src/prediction/availability/slas.ts`
- CREATE `packages/core/src/prediction/availability/index.ts`
- CREATE `packages/core/src/prediction/availability/slo.ts`
- CREATE `packages/core/src/prediction/availability/availability.test.ts`
- CREATE `packages/core/src/prediction/availability/slo.test.ts`
- MODIFY `packages/core/src/prediction/assumptions.ts` - add `availability.azCorrelation`
- MODIFY `packages/core/src/index.ts` - export the availability and SLO surface

### Acceptance Criteria

- [ ] A series path is never more available than its least available component
- [ ] Adding a component to the request path lowers composite availability
- [ ] Three AZs give a higher figure than one, and a lower figure than the independent-failure formula would
- [ ] A configuration with a published AWS SLA uses that value and reports `basis: 'published'`
- [ ] Single-AZ and Multi-AZ RDS produce different figures, both traceable to a published SLA
- [ ] Setting `availability.azCorrelation` to 0 reproduces the independent-failure result exactly
- [ ] Every entry in `AWS_SLAS` carries a source URL and a retrieval date
- [ ] A resource with no SLA and no model appears in `unmodelled` and does not silently count as perfect
- [ ] Downtime is reported in minutes over a 30-day window, matching the window AWS SLAs use
- [ ] The proposed availability SLO is never above the modelled availability
- [ ] Each proposal carries an SLI with a numerator and denominator naming real CloudWatch metrics
- [ ] Every result is wrapped in `Prediction` with `label: 'Predicted'` and its assumptions

### Required Tests

- `a series path is no better than its weakest component`
- `adding a component to the path lowers availability`
- `three availability zones beat one`
- `correlated failure lowers the parallel result below the independent formula`
- `zero correlation reproduces the independent formula`
- `prefers a published sla over a computed value`
- `distinguishes single-az from multi-az rds`
- `reports an unmodelled resource rather than treating it as perfect`
- `never proposes an slo above the modelled availability`
- `converts availability to an error budget in minutes over thirty days`

### Performance Budget

Computing availability and the SLO proposals for a 40-resource architecture completes in under 5ms,
measured over 100 iterations with `performance.now()` and asserted on the median.

### Out of Scope

- Do not model SLA service credits or billing consequences
- Do not add burn-rate alerting or CloudWatch alarm definitions; Epic #10 owns deployment monitoring
- Do not model multi-region topologies; the AZ topology is what the canvas can express today
- Do not produce cost or bottleneck figures
- Do not change the latency model to emit percentiles in a different shape; consume `PathLatency` as it is

### Dependencies

Blocked by the Resource Contract in `docs/issues/epic-2-ir/010-architecture-ir-schema.md` (Epic #3),
and by the latency model in `docs/issues/epic-7-prediction/030-latency-model.md`.

### Verification

```bash
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core build
pnpm lint && pnpm typecheck
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
