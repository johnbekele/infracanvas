---
title: '[ir] Cost model per resource and the architecture roll-up'
labels: tier:2, size:l, area:ir, epic:7-prediction
---

### Epic

#8

### Context

An architecture on the canvas is currently free, which is the one thing it certainly is not. This
issue attaches a monthly cost to each resource and adds them up. The hard part is not arithmetic; it
is that almost every input is a guess. Nobody knows how many requests the application will serve, how
much data it will store, or how long an average request holds a connection, and a cost figure derived
from invented traffic is worthless unless the invention is visible.

Every guess is therefore an `Assumption` with an id, a value, a unit, where it came from, and a
sentence of rationale, and every cost line names the assumptions its quantity came from. That is
what makes the number arguable: a user who thinks 2 million requests a month is nonsense can see the
figure, change it, and watch the total move. The alternative -- a single confidence range on the
total -- was rejected because it tells a user the answer might be wrong without telling them which
part to fix.

The assumption index is also what makes editing cheap. Each line declares the assumptions it depends
on, so changing one recomputes only the lines that named it and re-adds the total. Recomputing the
whole architecture would be fast enough at this size, but the epic requires that changing an
assumption does not re-run the analysis, and an index that is only used as an optimisation is an
index that stops being correct.

**An unpriced resource is reported, never charged zero.** A service with no cost function, a region
outside the snapshot, or an attribute combination with no matching SKU all produce an entry in
`unpriced` with a reason. Silently contributing zero would make a missing model look like a cheap
architecture, which is the single most misleading thing this feature could do.

Cost functions are registered per `serviceId` in a table rather than selected by a `switch`, matching
how `packages/core/src/analysis/architecture.ts` already keys behaviour off the catalog, so adding a
service is one file and one entry.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```typescript
// packages/core/src/prediction/prediction.ts
export interface Assumption {
  /** Dotted and stable, for example `traffic.requestsPerMonth`. Referenced by cost lines. */
  id: string;
  label: string;
  value: number;
  unit: string;
  /** `profile` means derived from the AppProfile; `user` means overridden on the canvas. */
  source: 'default' | 'profile' | 'user';
  rationale: string;
}

/**
 * Every modelled number in this epic is returned inside this envelope. The
 * label is a literal rather than a boolean so no renderer can print a
 * prediction without saying that is what it is.
 */
export interface Prediction<T> {
  label: 'Predicted';
  value: T;
  assumptions: Assumption[];
  /** Inputs that were missing, in plain language. */
  gaps: string[];
}
```

```typescript
// packages/core/src/prediction/cost/index.ts
export interface CostLine {
  resourceId: string;
  component: 'compute' | 'storage' | 'requests' | 'data-transfer' | 'baseline';
  quantity: number;
  unit: PriceUnit;
  unitPriceUsd: number;
  monthlyUsd: number;
  /** The AWS SKU the unit price came from, so a figure can be traced. */
  sku: string;
  /** Assumption ids this quantity was derived from. Empty means a fixed rate. */
  assumptionIds: string[];
}

export interface ResourceCost {
  resourceId: string;
  serviceId: string;
  monthlyUsd: number;
  lines: CostLine[];
  /** One entry per line that could not be priced, with the reason. */
  unpriced: string[];
}

export interface ArchitectureCost {
  monthlyUsd: number;
  byResource: ResourceCost[];
  unpriced: string[];
}

export interface CostContext {
  snapshot: PriceSnapshot;
  region: string;
  assumptions: Map<string, Assumption>;
}

export function costModel(resource: Resource, ctx: CostContext): Prediction<ResourceCost>;

export function rollUpCost(costs: Prediction<ResourceCost>[]): Prediction<ArchitectureCost>;

/**
 * Recompute after one assumption changes. Only lines whose `assumptionIds`
 * contain `id` are recalculated; everything else is carried over by reference.
 */
export function reviseAssumption(
  estimate: Prediction<ArchitectureCost>,
  id: string,
  value: number,
  ctx: CostContext
): Prediction<ArchitectureCost>;

export type ServiceCostModel = (resource: Resource, ctx: CostContext) => ResourceCost;

/** Adding a service is a file plus an entry here. */
export const COST_MODELS: Record<string, ServiceCostModel>;
```

`Resource` is the Resource Contract from Epic #3. Where it is not yet available, the cost functions
take `{ id: string; serviceId: string; properties: Record<string, string | number | boolean> }`,
which is the shape `ProposedNode` in `packages/core/src/analysis/architecture.ts` already carries.

The defaults, each an `Assumption` in its own right rather than a constant buried in a formula:

```typescript
export const DEFAULT_ASSUMPTIONS: Assumption[] = [
  { id: 'time.hoursPerMonth', value: 730, unit: 'h', source: 'default', ... },
  { id: 'traffic.requestsPerMonth', value: 2_000_000, unit: 'requests', source: 'default', ... },
  { id: 'traffic.averageResponseKb', value: 24, unit: 'KB', source: 'default', ... },
  { id: 'storage.databaseGb', value: 20, unit: 'GB', source: 'default', ... },
  { id: 'storage.objectGb', value: 50, unit: 'GB', source: 'default', ... },
  { id: 'compute.instanceCount', value: 2, unit: 'instances', source: 'default', ... },
  { id: 'egress.internetGbPerMonth', value: 100, unit: 'GB', source: 'default', ... },
];
```

Services priced in this issue: `ec2`, `ecs`, `rds`, `elasticache`, `s3`, `cloudfront`, `alb`, `sqs`,
`dynamodb`, `lambda`. Anything else in the catalog is `unpriced` with the reason "no cost model".

Accuracy is pinned by a fixture recording what the AWS Pricing Calculator says for three reference
architectures, with the region, the date it was read, and the input parameters:
`packages/core/src/prediction/__fixtures__/calculator-baselines.json`.

### Files

- CREATE `packages/core/src/prediction/prediction.ts`
- CREATE `packages/core/src/prediction/assumptions.ts`
- CREATE `packages/core/src/prediction/cost/index.ts`
- CREATE `packages/core/src/prediction/cost/compute.ts`
- CREATE `packages/core/src/prediction/cost/data.ts`
- CREATE `packages/core/src/prediction/cost/network.ts`
- CREATE `packages/core/src/prediction/cost/cost.test.ts`
- CREATE `packages/core/src/prediction/cost/baselines.test.ts`
- CREATE `packages/core/src/prediction/__fixtures__/calculator-baselines.json`
- MODIFY `packages/core/src/index.ts` - export the prediction surface

### Acceptance Criteria

- [ ] Every returned figure is wrapped in `Prediction` with `label: 'Predicted'` and a non-empty assumption list
- [ ] Every cost line names the SKU its unit price came from
- [ ] A resource with no cost model appears in `unpriced` with a reason and contributes nothing to the total
- [ ] A resource in a region absent from the snapshot is unpriced rather than priced from another region
- [ ] `reviseAssumption` recomputes only the lines that declared the changed assumption, asserted by counting calls
- [ ] `reviseAssumption` produces the same total as a full recomputation with the same inputs
- [ ] An assumption overridden by the user is marked `source: 'user'` and survives the roll-up
- [ ] The roll-up total equals the sum of its resource totals to the cent, with no floating-point drift past 0.01
- [ ] Each of the three reference architectures is within 10% of its recorded calculator baseline
- [ ] Pricing the same architecture twice returns identical output

### Required Tests

- `prices an EC2 instance from the snapshot rate and the hours assumption`
- `prices RDS storage and instance hours as separate lines`
- `reports a catalog service with no cost model as unpriced`
- `does not substitute another region when the requested one is missing`
- `recomputes only the lines that named the changed assumption`
- `matches a full recomputation after a revision`
- `keeps the roll-up total equal to the sum of its parts`
- `stays within ten per cent of the recorded calculator baseline for each reference architecture`
- `returns the same result for the same architecture twice`

### Performance Budget

Pricing a 40-resource architecture completes in under 20ms, and a single `reviseAssumption` call in
under 2ms, both measured over 100 iterations with `performance.now()` in the vitest suite and
asserted on the median.

### Out of Scope

- Do not rebuild or extend the price snapshot; `010-price-list-snapshot.md` owns its contents
- Do not model Reserved Instances, Savings Plans, free tiers, or enterprise discounts
- Do not add latency or availability figures; `030-latency-model.md` and `050-availability-and-slo.md` own those
- Do not add a cost panel to the canvas; this issue delivers the model and its exports
- Do not change `packages/core/src/analysis/architecture.ts` to carry cost fields

### Dependencies

Blocked by the Resource Contract in `docs/issues/epic-2-ir/010-architecture-ir-schema.md` (Epic #3),
and by the snapshot in `docs/issues/epic-7-prediction/010-price-list-snapshot.md`.

### Verification

```bash
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core build
pnpm lint && pnpm typecheck
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
