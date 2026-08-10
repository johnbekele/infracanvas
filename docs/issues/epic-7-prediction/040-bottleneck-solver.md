---
title: '[ir] Bottleneck solver over queueing capacity and AWS service limits'
labels: tier:2, size:m, area:ir, epic:7-prediction
---

### Epic

#8

### Context

"Will this architecture hold?" is the question a diagram cannot answer and the reason the prediction
epic exists. `030-latency-model.md` says how slow each component is at a given load; this issue
inverts that and answers which component gives way first, and at what request rate.

Two different things break. The first is capacity: a queueing resource cannot serve faster than
`c * mu`, so above that its queue grows without bound no matter how the account is configured. The
second is a quota: Lambda stops at its concurrent execution limit, an RDS instance stops at
`max_connections`, a NAT gateway stops at 55,000 connections to one destination. Quotas usually bind
first, and they are invisible on a diagram, which is exactly why an architecture that looks fine
falls over in a load test.

Little's Law is what connects the two. `L = lambda * W` turns a request rate and a residence time
into a number of things in flight, and a number of things in flight is what every one of those quotas
is actually counting -- connections, concurrent executions, in-flight messages. So the residence time
already computed per resource becomes a demand figure that can be compared against a published limit,
without a second model.

**The limits are data with citations, not branches in code.** Each entry carries its value, its unit,
whether it is adjustable, its Service Quotas code when it has one, the documentation URL it was read
from, and the date it was read. AWS changes these, and a limit encoded as an `if` in a solver is one
nobody will ever find to update. It also means the report can say "raise this quota" instead of
"redesign this", which is usually the correct advice and costs nothing.

**Solved by bisection rather than algebra.** Every limit exposes usage as a function of request rate
that never decreases, so the first rate at which usage reaches the limit can be found by bisection to
a tolerance of half a request per second in about eighteen steps. Solving each limit analytically
would be faster and would have to be redone, correctly, for every new limit form; monotonicity is one
property to test per limit, and the solver is then the same code for all of them.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```typescript
// packages/core/src/prediction/limits/types.ts
export interface ServiceLimit {
  /** Dotted and stable, for example `lambda.concurrentExecutions`. */
  id: string;
  serviceId: string;
  label: string;
  value: number;
  unit: string;
  /** True when Service Quotas can raise it, which changes the remedy. */
  adjustable: boolean;
  /** The Service Quotas code, for example `L-B99A9384`. Null when there is none. */
  quotaCode: string | null;
  /** Documentation URL the value was read from. */
  source: string;
  /** ISO date the value was read. AWS changes these. */
  retrievedAt: string;
  /** Must be non-decreasing in `rps`; asserted for every limit by test. */
  usageAt(resource: Resource, rps: number, ctx: BottleneckContext): number;
}
```

```typescript
// packages/core/src/prediction/bottleneck/index.ts
export const RPS_CEILING = 100_000;
export const RPS_TOLERANCE = 0.5;

export interface Bottleneck {
  resourceId: string;
  limitId: string;
  label: string;
  /** The lowest request rate at which usage reaches the limit. */
  breakingRps: number;
  limitValue: number;
  usageAtTarget: number;
  headroomRps: number;
  adjustable: boolean;
  /** One sentence: raise the quota, add servers, or change the design. */
  remedy: string;
}

export interface BottleneckReport {
  targetRps: number;
  /** Null when nothing breaks below RPS_CEILING; a gap is recorded instead. */
  first: Bottleneck | null;
  /** Ascending by breakingRps. */
  ranked: Bottleneck[];
}

export function findBottleneck(
  architecture: Resource[],
  ctx: BottleneckContext
): Prediction<BottleneckReport>;

/** Little's Law. `residenceSeconds` is W from the latency model. */
export function concurrency(rps: number, residenceSeconds: number): number;

/** Lowest rps in [0, RPS_CEILING] where usage reaches the limit, by bisection. */
export function solveBreakingRps(
  limit: ServiceLimit,
  resource: Resource,
  ctx: BottleneckContext
): number | null;
```

The limit table, one file per service family, each entry sourced:

```typescript
// packages/core/src/prediction/limits/aws-limits.ts
export const AWS_LIMITS: ServiceLimit[] = [
  {
    id: 'lambda.concurrentExecutions',
    serviceId: 'lambda',
    label: 'Concurrent executions per region',
    value: 1000,
    unit: 'executions',
    adjustable: true,
    quotaCode: 'L-B99A9384',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html',
    retrievedAt: '2026-08-10',
    usageAt: (resource, rps, ctx) => concurrency(rps, residenceSeconds(resource, rps, ctx)),
  },
  // rds.maxConnections, elasticache.clientConnections, natGateway.connectionsPerDestination,
  // sqs.fifoThroughput, dynamodb.partitionReadUnits, ecs.tasksPerService,
  // alb.targetsPerTargetGroup, and the queueing capacity limit below.
];
```

Capacity is expressed as a limit like any other, so one solver covers both kinds:

```typescript
{
  id: 'queue.capacity',
  label: 'Serving capacity before the queue grows without bound',
  value: SATURATION_THRESHOLD,        // 0.95, shared with the latency model
  unit: 'utilisation',
  adjustable: false,
  usageAt: (resource, rps, ctx) => utilisationAt(resource, rps, ctx),
}
```

### Files

- CREATE `packages/core/src/prediction/limits/types.ts`
- CREATE `packages/core/src/prediction/limits/aws-limits.ts`
- CREATE `packages/core/src/prediction/bottleneck/index.ts`
- CREATE `packages/core/src/prediction/bottleneck/solve.ts`
- CREATE `packages/core/src/prediction/bottleneck/bottleneck.test.ts`
- CREATE `packages/core/src/prediction/limits/aws-limits.test.ts`
- MODIFY `packages/core/src/index.ts` - export the bottleneck surface

### Acceptance Criteria

- [ ] `concurrency` implements `L = lambda * W` and is exported and tested independently
- [ ] `findBottleneck` returns the component with the lowest breaking rate as `first`
- [ ] `ranked` is sorted ascending by `breakingRps` with no duplicates
- [ ] The solved breaking rate is within 0.5 rps of the true crossing for a limit with a known closed form
- [ ] Every limit's `usageAt` is non-decreasing in rps, asserted by sampling each limit across the range
- [ ] Nothing breaking below 100,000 rps yields `first: null` and a recorded gap, not a fabricated figure
- [ ] An adjustable limit reports its Service Quotas code and a remedy that says to raise it
- [ ] A non-adjustable capacity limit reports a remedy that says to add servers or change the resource
- [ ] Every entry in `AWS_LIMITS` carries a source URL and a retrieval date
- [ ] The queueing capacity limit uses the same saturation threshold as the latency model, imported rather than repeated
- [ ] The report is wrapped in `Prediction` and lists the assumptions the residence times came from

### Required Tests

- `computes required concurrency from little's law`
- `returns the component that breaks first`
- `finds the rate at which lambda concurrent executions are exhausted`
- `finds the rate at which an rds instance runs out of connections`
- `reports no bottleneck below the ceiling rather than inventing one`
- `every limit is non-decreasing in request rate`
- `solves within tolerance against a closed-form limit`
- `names the quota code and a raise-the-quota remedy for an adjustable limit`
- `falls back to queueing capacity when no quota binds first`

### Performance Budget

Solving a 40-resource architecture against the full limit table completes in under 15ms, measured
over 100 iterations with `performance.now()` and asserted on the median. Each bisection is capped at
40 iterations.

### Out of Scope

- Do not call the Service Quotas API or any AWS endpoint; the table is static data
- Do not model autoscaling policies or warm pools
- Do not produce cost or availability figures
- Do not change the latency model's formulas; import `SATURATION_THRESHOLD` and the residence time
- Do not add a load test; Epic #11 owns validating these predictions against real traffic

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
