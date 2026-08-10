---
title: '[ir] Resource Contract registry with RDS as the reference implementation'
labels: tier:2, size:l, area:ir, epic:2-ir
---

### Epic

#3

### Context

Every downstream feature asks the same seven questions of a resource: what parameters does it take,
what does it cost, what does it add to end-to-end latency, what does it do to availability, which
Well-Architected rules apply, what Pulumi does it emit, and what output is known-good. Answering them
resource by resource in whichever module happens to need the answer is how the current code got a
cost estimate nowhere, a Pulumi emitter in a 500-line `switch`, and no latency model at all. This
issue defines one interface that holds all seven answers for a resource, and a registry that keeps
them together.

The value is in the shape being enforced rather than in any single resource being modelled. Once the
interface exists and one resource satisfies it end to end, the remaining twenty-three are mechanical
work an agent can do from the reference without a design conversation, and a resource that is missing
its latency model or its golden test cannot be registered at all. That is why this issue implements
exactly one resource fully and none of the others: a registry with twenty-four half-filled entries
teaches the next agent that half-filled is acceptable.

**The reference resource is `rds_instance`, and the choice is deliberate.** It is the only resource in
the catalogue that exercises all seven parts non-trivially. Its cost has two components with different
units, instance-hours and provisioned storage-gigabyte-months, so `CostEstimate` has to carry a
breakdown rather than one number. It contributes real query latency, so `LatencyContribution` is not a
placeholder. Its availability changes measurably with `multiAz`, so `ReliabilityContribution` has to
be a function of parameters rather than a constant. It has three Well-Architected rules that are
checkable from parameters already in `aws-services.ts` (`publiclyAccessible`, `multiAz`,
`deletionProtection`), covering three different pillars. And it has a placement constraint the
containment model must respect, since `subnetPlacement.allowedInPublic` is false. `s3_bucket` was the
obvious alternative and was rejected as the reference precisely because it is easy: cost is one usage
term, latency and reliability are effectively constants, and an interface validated only against it
would not have needed a breakdown or a parameterised reliability model at all. `ecs_service` was
rejected in the other direction, because a useful emitter for it also needs a cluster, a task
definition, a target group, and a load balancer, which is four resources in one issue.

Cost is deterministic and comes from a checked-in price snapshot, not from a live API call. A cost
that changes between two runs over the same architecture is not something a user can act on, and unit
tests cannot assert against a network. The snapshot records the price list version and the date it was
taken; syncing it from the AWS Price List API belongs to the prediction epic (#8), which is also where
the accuracy check against real bills lives.

Spec: `docs/DELIVERY.md`

### Contract

```typescript
// packages/core/src/resources/contract.ts
import type { IrNode, ResourceKind } from '@infracanvas/ir-schema';

export type ParamsOf<K extends ResourceKind> = Extract<IrNode, { kind: K }>['params'];

/** Traffic and size assumptions a cost or latency model needs. Supplied by the caller, never guessed. */
export interface UsageAssumptions {
  hoursPerMonth: number;
  requestsPerMonth: number;
  averageRequestKb: number;
  storageGb: number;
  region: string;
}

export interface CostComponent {
  label: string;
  /** For example `instance-hour`, `gb-month`, `million-requests`. */
  unit: string;
  quantity: number;
  unitPriceUsd: number;
  monthlyUsd: number;
}

export interface CostEstimate {
  monthlyUsd: number;
  components: CostComponent[];
  /** Identifies the snapshot the prices came from, so a number can be traced to a source. */
  priceSource: { file: string; priceListVersion: string; capturedAt: string };
  /** Parameters the model could not price. Reported rather than assumed to be free. */
  unpriced: string[];
}

export interface LatencyContribution {
  /** Added to a request that traverses this resource once. */
  p50Ms: number;
  p95Ms: number;
  /** How the numbers were arrived at, shown to the user next to the estimate. */
  basis: string;
}

export interface ReliabilityContribution {
  /** Availability of this resource alone, as a fraction, for example 0.9995. */
  availability: number;
  annualDowntimeMinutes: number;
  /** True when losing this one resource takes the architecture down. */
  singlePointOfFailure: boolean;
}

export type Pillar =
  | 'operational-excellence'
  | 'security'
  | 'reliability'
  | 'performance-efficiency'
  | 'cost-optimisation'
  | 'sustainability';

export interface RuleFinding {
  ruleId: string;
  pillar: Pillar;
  severity: 'high' | 'medium' | 'low';
  message: string;
  /** JSON Pointer into the node, so the canvas can highlight the offending field. */
  pointer: string;
  remediation: string;
}

export interface WellArchitectedRule<K extends ResourceKind> {
  id: string;
  pillar: Pillar;
  severity: 'high' | 'medium' | 'low';
  /** Null when the rule passes. A rule never throws. */
  evaluate(params: ParamsOf<K>, context: RuleContext): RuleFinding | null;
}

export interface RuleContext {
  /** The node's ancestors, nearest first, so a rule can see which subnet tier it sits in. */
  ancestors: IrNode[];
  region: string;
}

export interface PulumiFragment {
  /** Deduplicated by the project assembler, for example `import * as aws from "@pulumi/aws";`. */
  imports: string[];
  /** TypeScript statements declaring this resource, referencing `refs` by variable name. */
  statements: string[];
  exports: string[];
}

export interface EmitContext {
  language: 'typescript';
  /** Variable name for another node's resource. Throws when the node is not in the document. */
  refFor(nodeId: string): string;
  varName: string;
}

export interface ResourceContract<K extends ResourceKind> {
  kind: K;
  /** `$defs` name in the IR schema that types `params`, checked against the schema in tests. */
  paramsDef: string;
  cost(params: ParamsOf<K>, usage: UsageAssumptions): CostEstimate;
  latency(params: ParamsOf<K>): LatencyContribution;
  reliability(params: ParamsOf<K>): ReliabilityContribution;
  rules: WellArchitectedRule<K>[];
  emitPulumi(params: ParamsOf<K>, context: EmitContext): PulumiFragment;
}
```

```typescript
// packages/core/src/resources/registry.ts
/** Throws when `kind` is already registered, so a duplicate is a startup failure rather than a race. */
export function registerResource<K extends ResourceKind>(contract: ResourceContract<K>): void;
export function getResourceContract<K extends ResourceKind>(
  kind: K
): ResourceContract<K> | undefined;
export function listResourceContracts(): ResourceContract<ResourceKind>[];
/** Kinds in the schema with no contract yet. Must equal the schema's `pendingContractNode` enum. */
export function kindsWithoutContract(): ResourceKind[];
```

The reference implementation, one file per part so a new resource is a directory copy:

```
packages/core/src/resources/rds-instance/
  index.ts        # assembles and registers the contract
  cost.ts         # instance-hours + gp3 storage, from the snapshot
  latency.ts      # per-query contribution, single-AZ versus multi-AZ writes
  reliability.ts  # 99.95% single-AZ, 99.99% multi-AZ, SPOF unless multiAz
  rules.ts        # RDS-SEC-001, RDS-REL-001, RDS-OPS-001
  emit.ts         # aws.rds.Instance plus its subnet group
  __golden__/three-tier.rds.ts
```

The three rules, stated so they are not reinvented:

- `RDS-SEC-001` (security, high): `publiclyAccessible` is true, or the instance's nearest `subnet`
  ancestor has `tier: 'public'`. Pointer `/params/publiclyAccessible`.
- `RDS-REL-001` (reliability, medium): `multiAz` is false. Pointer `/params/multiAz`.
- `RDS-OPS-001` (operational-excellence, medium): `deletionProtection` is false. Pointer
  `/params/deletionProtection`.

Golden tests compare `emitPulumi` output against the checked-in file byte for byte, and are updated
by `pnpm --filter @infracanvas/core test -- -u` only when the diff has been read. A golden file is the
only practical way to review generated infrastructure code, because the failure mode that matters is
a plausible-looking change to a resource argument.

This issue also adds `rds_instance` to the IR schema as a typed node kind and removes it from the
`pendingContractNode` enum, which is a schema change and therefore requires a minor bump of
`packages/ir-schema/VERSION` and regeneration of both languages' types. `kindsWithoutContract()`
returning exactly the schema's pending enum is asserted in a test, so the two lists cannot diverge.

### Files

- CREATE `packages/core/src/resources/contract.ts`
- CREATE `packages/core/src/resources/registry.ts`
- CREATE `packages/core/src/resources/registry.test.ts`
- CREATE `packages/core/src/resources/pricing/rds-us-east-1.json` - price snapshot with its version and capture date
- CREATE `packages/core/src/resources/rds-instance/index.ts`
- CREATE `packages/core/src/resources/rds-instance/cost.ts`
- CREATE `packages/core/src/resources/rds-instance/latency.ts`
- CREATE `packages/core/src/resources/rds-instance/reliability.ts`
- CREATE `packages/core/src/resources/rds-instance/rules.ts`
- CREATE `packages/core/src/resources/rds-instance/emit.ts`
- CREATE `packages/core/src/resources/rds-instance/rds-instance.test.ts`
- CREATE `packages/core/src/resources/rds-instance/__golden__/three-tier.rds.ts`
- CREATE `packages/core/src/resources/README.md` - the seven parts and how to add the next resource
- MODIFY `packages/ir-schema/schema/architecture-ir.schema.json` - type `rds_instance`, drop it from the pending enum
- MODIFY `packages/ir-schema/VERSION` - minor bump
- MODIFY `packages/ir-schema/src/generated/types.ts` - regenerated
- MODIFY `services/brain/src/brain/ir/models.py` - regenerated
- MODIFY `packages/ir-schema/fixtures/three-tier.json` - use the now-typed RDS parameters
- MODIFY `packages/core/src/index.ts` - export the registry, the contract types, and the RDS contract

### Acceptance Criteria

- [ ] `registerResource` throws when a kind is registered twice
- [ ] `kindsWithoutContract()` returns exactly the kinds in the schema's `pendingContractNode` enum
- [ ] `cost` for `db.t3.micro` with 20GB returns components for instance-hours and storage whose `monthlyUsd` values sum to the total
- [ ] `cost` lists any parameter it did not price in `unpriced` rather than treating it as free
- [ ] `reliability` reports a higher availability and `singlePointOfFailure: false` when `multiAz` is true
- [ ] `latency` reports a higher `p95Ms` for multi-AZ than single-AZ, because a write waits on the standby
- [ ] `RDS-SEC-001` fires when `publiclyAccessible` is true, and also when the instance's nearest subnet ancestor is public
- [ ] Every rule returns null rather than throwing when a parameter is absent
- [ ] `emitPulumi` output matches `__golden__/three-tier.rds.ts` byte for byte
- [ ] `emitPulumi` throws when `refFor` is asked for a node id the document does not contain
- [ ] Regenerating types after the schema change leaves the working tree clean

### Required Tests

- `refuses to register the same resource kind twice`
- `reports every kind without a contract, matching the schema pending list`
- `cost components sum to the monthly total`
- `cost reports unpriced parameters rather than assuming they are free`
- `multi az raises availability and clears the single point of failure flag`
- `multi az raises write latency`
- `flags a publicly accessible instance`
- `flags an instance placed in a public subnet even when publiclyAccessible is false`
- `emits pulumi matching the golden file`

### Performance Budget

Evaluating cost, latency, reliability, and every rule for a 200-node document completes in under 50ms,
measured with `performance.now()` in `registry.test.ts`. Contract lookup is a `Map` read, so the cost
is in the models rather than in dispatch.

### Out of Scope

- Do not implement contracts for the other twenty-three kinds. Each is its own issue, copied from the
  RDS directory, and a partial second resource is worse than none
- Do not call the AWS Price List API. The snapshot is the source until the sync lands in #8
- Do not touch `packages/core/src/codegen/pulumi.ts` or `terraform.ts`. The `switch`-based generators
  keep working until the emitters exist for every kind, and replacing them mid-way leaves two
  half-authorities. That replacement is the codegen epic (#9)
- Do not add Checkov or any external policy engine; coded rules only in this issue
- Do not add cost or rule evaluation endpoints to `apps/api` or `services/brain`

### Dependencies

Blocked by `docs/issues/epic-2-ir/010-architecture-ir-schema.md`,
`docs/issues/epic-2-ir/020-ir-type-generation.md`, and
`docs/issues/epic-2-ir/030-canvas-ir-round-trip.md` for the `ancestors` walk that `RuleContext`
needs. The price list sync that eventually replaces the snapshot is #8.

### Verification

```bash
pnpm --filter @infracanvas/ir-schema generate && git diff --exit-code
pnpm --filter @infracanvas/ir-schema test
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core typecheck
uv run --directory services/brain mypy
pnpm lint
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
