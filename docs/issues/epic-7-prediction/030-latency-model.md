---
title: '[ir] Latency contribution per resource and the path roll-up'
labels: tier:2, size:m, area:ir, epic:7-prediction
---

### Epic

#8

### Context

The tempting way to predict latency is to give each service a number -- an ALB is 2ms, a database
query is 8ms -- and add them along the request path. That model has one property that disqualifies
it: the answer does not change with load. It says the architecture behaves the same at 10 requests
per second as at 10,000, which is the opposite of the truth and hides the only latency problem worth
predicting, which is what happens as a component fills up.

Queueing gives the load dependence for free. Each resource is a service centre with an arrival rate
λ, a service rate μ, and c servers, and the time a request spends there is service time plus the
time it waits behind other requests, which grows without bound as utilisation approaches one.

**M/M/c, with M/M/1 as its one-server case.** The inputs it needs are exactly the inputs available:
an arrival rate from the traffic assumptions, a mean service time from the per-service defaults, and
a server count from the resource properties. The obvious upgrade is Kingman's G/G/c approximation,
which corrects for burstiness -- but it needs the coefficients of variation of the inter-arrival and
service time distributions, and for an application that has not been deployed nobody has them.
Setting both to one, which is the only defensible default, reduces Kingman to M/M/c exactly. So
`traffic.arrivalCv` and `service.serviceCv` exist as assumptions defaulting to 1, and the Kingman
correction factor is applied when a user supplies something else. That gives the extension point to
anyone with measurements without pretending to have them.

**Percentiles are not added.** The mean of a path is the sum of the means -- that holds by linearity
whatever the distributions and whatever the correlations -- but the 95th percentile of a sum is not
the sum of the 95th percentiles, and treating it as one overstates tail latency badly on a long
path. Percentiles are therefore taken from the path's own distribution, obtained by convolving the
per-resource sojourn-time distributions on a shared grid, and a parallel fan-out takes the maximum
under independence, which is the product of the branch CDFs rather than the maximum of their
percentiles.

**Saturation is reported, not computed through.** Above ρ = 0.95 the M/M/c queue length is dominated
by the modelling error rather than by the model, so the contribution is flagged `saturated`, the
utilisation is reported, and the latency is clamped at the ρ = 0.95 value. A component that is
already past its capacity is a bottleneck finding, and `040-bottleneck-solver.md` is where that
belongs; printing 40 seconds of queueing here would be arithmetic dressed as a prediction.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```typescript
// packages/core/src/prediction/latency/index.ts
export type QueueModel = 'm/m/1' | 'm/m/c' | 'fixed';

export const SATURATION_THRESHOLD = 0.95;

export interface LatencyContribution {
  resourceId: string;
  model: QueueModel;
  /** c. One for a single-threaded resource, the instance or task count otherwise. */
  servers: number;
  /** 1 / mu, in milliseconds. */
  serviceTimeMs: number;
  /** lambda, in requests per second, after any fan-out on the path. */
  arrivalRateRps: number;
  /** rho = lambda / (c * mu). */
  utilisation: number;
  saturated: boolean;
  /** Wq, the time spent waiting rather than being served. */
  queueMs: number;
  /** W = Wq + 1/mu. */
  totalMs: number;
  assumptionIds: string[];
}

export interface PathLatency {
  path: string[];
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  contributions: LatencyContribution[];
  /** Resource ids at or above the saturation threshold, in path order. */
  saturatedAt: string[];
}

export function latencyContribution(
  resource: Resource,
  ctx: LatencyContext
): Prediction<LatencyContribution>;

export function pathLatency(path: PathSegment[], ctx: LatencyContext): Prediction<PathLatency>;

/** Erlang C, the probability an arrival has to wait. Exported because it is
 *  the one piece worth testing against published values. */
export function erlangC(servers: number, utilisation: number): number;
```

The formulas, so two implementations cannot differ:

```
rho    = lambda / (c * mu)
Pwait  = erlangC(c, rho)
Wq     = Pwait / (c * mu - lambda)
W      = Wq + 1 / mu

M/M/1 percentile, closed form:  t_q = ln(1 / (1 - q)) / (mu - lambda)
M/M/c percentiles:              invert the sojourn-time CDF by bisection on t
Kingman correction, cv != 1:    Wq *= (ca^2 + cs^2) / 2
```

Path composition:

```
sequential  mean:        sum of the resource means, exactly
sequential  percentile:  invert the convolution of the resource CDFs on a
                         shared grid of 1024 points spanning 0 to 4x the sum
                         of the resource p99 values
parallel    percentile:  invert the product of the branch CDFs, which is the
                         maximum under independence
```

Default mean service times, each an `Assumption` so a user can replace one with a measurement:

```typescript
export const DEFAULT_SERVICE_TIMES_MS: Record<string, number> = {
  alb: 1.5,
  cloudfront: 10,
  ec2: 40,
  ecs: 40,
  lambda: 55,
  rds: 8,
  elasticache: 0.6,
  dynamodb: 6,
  s3: 25,
  sqs: 12,
};
```

Contributions carry `assumptionIds` and participate in the same assumption index as
`020-cost-model.md`, so `reviseAssumption` recomputes only the paths that touch a changed resource.

### Files

- CREATE `packages/core/src/prediction/latency/index.ts`
- CREATE `packages/core/src/prediction/latency/queue.ts`
- CREATE `packages/core/src/prediction/latency/distribution.ts`
- CREATE `packages/core/src/prediction/latency/paths.ts`
- CREATE `packages/core/src/prediction/latency/queue.test.ts`
- CREATE `packages/core/src/prediction/latency/latency.test.ts`
- MODIFY `packages/core/src/prediction/assumptions.ts` - add the service time and variability assumptions
- MODIFY `packages/core/src/index.ts` - export the latency surface

### Acceptance Criteria

- [ ] `erlangC` matches published Erlang C values for c of 1, 2, 5 and 20 to six decimal places
- [ ] With one server the model reproduces the M/M/1 closed-form waiting time to within 1e-9
- [ ] Utilisation at or above 0.95 sets `saturated`, clamps the queue time, and lists the resource in `saturatedAt`
- [ ] The mean of a path equals the sum of its contributions' means to within 1e-9
- [ ] A path's p95 is strictly below the sum of its resources' p95 values whenever the path has more than one queueing resource
- [ ] A parallel fan-out reports the slower branch, not the sum of the branches
- [ ] Doubling the arrival rate increases queueing time by more than a factor of two at utilisation above 0.5
- [ ] A resource with no queueing model returns a `fixed` contribution with utilisation zero
- [ ] Every result is wrapped in `Prediction` with `label: 'Predicted'` and the assumptions it used
- [ ] A service time supplied by the user replaces the default and is marked `source: 'user'`

### Required Tests

- `matches published erlang c values`
- `reduces to the m/m/1 waiting time with a single server`
- `flags saturation instead of returning an unbounded queue`
- `path mean equals the sum of the resource means`
- `path p95 is below the sum of the resource p95 values`
- `parallel fan-out takes the slower branch`
- `queueing grows superlinearly with the arrival rate`
- `returns a fixed contribution for a resource with no queue`
- `applies the kingman correction only when a variability assumption is supplied`

### Performance Budget

Latency for 20 paths across a 40-resource architecture, including the 1024-point convolutions,
completes in under 10ms measured over 100 iterations with `performance.now()` and asserted on the
median.

### Out of Scope

- Do not solve for the breaking arrival rate or read service quotas; `040-bottleneck-solver.md` owns that
- Do not model cold starts, retries, or connection pool acquisition as separate stages
- Do not add cost or availability figures
- Do not measure real latency or call AWS; every input is an assumption or a catalog default
- Do not change `packages/core/src/analysis/architecture.ts` to carry latency fields

### Dependencies

Blocked by the Resource Contract in `docs/issues/epic-2-ir/010-architecture-ir-schema.md` (Epic #3),
and by the prediction envelope in `docs/issues/epic-7-prediction/020-cost-model.md`.

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
