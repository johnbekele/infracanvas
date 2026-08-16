---
title: '[ir] Resource contracts for the edge: load balancer, CloudFront and NAT gateway'
labels: tier:2, size:l, area:ir, epic:2-ir
---

### Epic

#3

### Context

`docs/issues/epic-2-ir/040-resource-contract-registry.md` defines the seven-part contract and fills it
in for `rds_instance` only, deliberately, so the shape is enforced before it is copied. The result is
that an architecture `proposeArchitecture` actually draws -- a CloudFront distribution, an S3 bucket,
a public subnet with an ALB in it, a private subnet with an ECS cluster and a database -- prices one
node and reports the other eleven as unpriced. An estimate panel in that state is a demo. This issue
closes the edge of the gap: the three kinds that sit between the internet and the application, where
the pricing is least obvious and the availability findings matter most.

The three are one issue rather than three because they share one model and one bug. Data transfer is
priced per gigabyte at whichever resource terminates the traffic, and every naive implementation
charges the same gigabyte twice: once at the ALB because requests pass through it, once at CloudFront
because it served them, and once again at the NAT gateway because something in a private subnet also
talks outward. Three separate issues means three agents each inventing an attribution rule, and the
sum of three plausible rules is a cost that is wrong in a way no single test catches. So the
attribution is specified once here, as a function over the IR's edges with one owner per byte and an
asserted conservation invariant, and the three cost models consume it.

The availability findings are the other reason to group them. A single-AZ load balancer and a single
NAT gateway are the two most common ways an architecture that looks redundant is not, and both are
invisible on a diagram: the canvas gives a node one parent, so an ALB drawn inside one public subnet
looks correct. `proposeArchitecture` never emits a NAT gateway at all -- `needsVpc` produces a VPC, a
public subnet, a private subnet and an ALB in `packages/core/src/analysis/architecture.ts`, and
nothing routes the private subnet outward -- so today the proposed architecture either cannot reach
the internet from its own services or hides the single largest fixed line in a small bill. Landing the
`nat_gateway` contract is what makes that omission a finding rather than a silence.

**Prices come from the prediction plane's snapshot, not from a second mechanism.** The RDS reference
reads a per-resource file, `packages/core/src/resources/pricing/rds-us-east-1.json`, which was
reasonable when nothing else existed and does not survive contact with three more kinds: four
hand-maintained JSON files disagree about the same region within a quarter. These contracts read
`data/pricing/aws-prices.v1.json.gz` through `loadPriceSnapshot` and `findRate` from
`docs/issues/epic-7-prediction/010-price-list-snapshot.md`, behind one thin helper so a contract never
formats a query itself. Migrating the RDS contract onto the same helper is named in Out of Scope
rather than done here, because changing a landed contract's numbers in an issue about three new ones
makes the diff unreviewable.

**Four things the contract interface cannot express, specified here rather than worked around.**
First, `CostComponent` has no SKU and no assumption list, while `CostLine` in
`docs/issues/epic-7-prediction/020-cost-model.md` requires both, so a component cannot be traced to a
rate or recomputed when an assumption changes. Second, `CostComponent` carries one `unitPriceUsd`,
and CloudFront data transfer out is graduated -- the first 10TB per month is not the next 40TB -- so a
single rate either overstates or understates every distribution above the first tier. Third,
`ReliabilityContribution` carries an availability and a boolean, but `AvailabilityNode` in
`docs/issues/epic-7-prediction/050-availability-and-slo.md` needs the configuration the number
belongs to, whether it came from a published SLA or a model, and the AZ count; and the AZ count for
an ALB is not in its own parameters alone, so `reliability` needs the context `rules` already gets.
Fourth, `RuleContext` carries ancestors and a region, which is enough for "is this instance in a
public subnet" and not enough for "is this distribution's origin bucket reachable without an origin
access control", so it gains the node itself and its resolved edge neighbours. Each extension is
additive and each is used by at least two of the three kinds below.

Spec: `docs/issues/epic-2-ir/040-resource-contract-registry.md`

### Contract

The additive changes to the shared contract module. Everything not shown is unchanged.

```typescript
// packages/core/src/resources/contract.ts
import type { ArchitectureIr, IrNode, ResourceKind } from '@infracanvas/ir-schema';

/**
 * An input a cost or latency model depends on and cannot know. Declared by the
 * contract so the estimate panel can render it as an editable field instead of
 * the model hiding it in a formula.
 */
export interface AssumptionRequirement {
  /** Dotted and stable, and the same id the prediction plane indexes on. */
  id: string;
  label: string;
  unit: string;
  defaultValue: number;
  /** Refused by the panel outside these bounds, so a zero divisor cannot be submitted. */
  min: number;
  max: number | null;
  rationale: string;
}

/** Declared here rather than in `data-transfer.ts` so the modules do not import each other. */
export type EgressClass = 'internet' | 'origin-fetch' | 'nat-processed' | 'inter-az';

export interface UsageAssumptions {
  hoursPerMonth: number;
  requestsPerMonth: number;
  averageRequestKb: number;
  storageGb: number;
  region: string;
  /** Any declared assumption by id. Undefined when the caller did not supply it, which a
   *  contract reports in `unpriced` rather than substituting a default of its own. */
  value(id: string): number | undefined;
  /** Gigabytes this resource owns, from `attributeDataTransfer`. Never guessed by a contract. */
  attributedGb(egressClass: EgressClass): number;
}

/** One step of a graduated rate. `toUnit` is null for the final, open-ended tier. */
export interface CostTier {
  fromUnit: number;
  toUnit: number | null;
  unitPriceUsd: number;
  quantity: number;
  monthlyUsd: number;
}

export interface CostComponent {
  label: string;
  /** For example `instance-hour`, `gb-month`, `lcu-hour`, `million-requests`. */
  unit: string;
  quantity: number;
  /** The effective rate. Equal to the single tier's rate when `tiers` is absent. */
  unitPriceUsd: number;
  monthlyUsd: number;
  /** The AWS SKU the rate came from, so a figure can be traced to the offer file. */
  sku: string;
  /** Assumption ids this quantity was derived from. Empty means a fixed rate. */
  assumptionIds: string[];
  /** Present only for a graduated rate. Quantities sum to `quantity`, totals to `monthlyUsd`. */
  tiers?: CostTier[];
}

export interface ReliabilityContribution {
  availability: number;
  annualDowntimeMinutes: number;
  singlePointOfFailure: boolean;
  /** The exact configuration the figure belongs to, for example `multi-az` or `single-az`. */
  configuration: string;
  /** `published` when an AWS SLA covers this configuration exactly, `modelled` otherwise. */
  basis: 'published' | 'modelled';
  /** Distinct availability zones this resource is placed in. One means zonal. */
  azCount: number;
  /** SLA document URL and the date it was read. Null for a modelled figure. */
  sla: { source: string; retrievedAt: string } | null;
}

export interface RuleContext {
  /** The node's ancestors, nearest first, so a rule can see which subnet tier it sits in. */
  ancestors: IrNode[];
  region: string;
  /** The node under evaluation, so a finding can name it. */
  node: IrNode;
  /** Nodes this node has an outbound edge to, and inbound from, resolved. Empty when a
   *  caller evaluates a rule against parameters alone, which every rule must tolerate. */
  targets: IrNode[];
  sources: IrNode[];
}

export interface EmitContext {
  language: 'typescript';
  /**
   * Variable name for another node's resource, or for a secondary resource that node's
   * contract declared in `secondaryRefs`. Throws when the node is not in the document or
   * when `part` is not one of its declared secondary refs.
   */
  refFor(nodeId: string, part?: string): string;
  varName: string;
}

export interface ResourceContract<K extends ResourceKind> {
  kind: K;
  paramsDef: string;
  /** Checked at registration: ids unique across the registry and dotted. */
  declaredAssumptions: AssumptionRequirement[];
  /** Names of the extra resources `emitPulumi` declares, addressable by `refFor(id, part)`. */
  secondaryRefs: string[];
  cost(params: ParamsOf<K>, usage: UsageAssumptions): CostEstimate;
  latency(params: ParamsOf<K>): LatencyContribution;
  reliability(params: ParamsOf<K>, context: RuleContext): ReliabilityContribution;
  rules: WellArchitectedRule<K>[];
  emitPulumi(params: ParamsOf<K>, context: EmitContext): PulumiFragment;
}
```

Rejected for `refFor(nodeId, part)`: letting a consumer build the name by string concatenation, for
example `` `${refFor(albId)}TargetGroup` ``. It works until one contract changes its internal naming
and the other's generated code stops compiling, with no type error anywhere.

The price lookup every contract in this group and the ones after it uses:

```typescript
// packages/core/src/resources/pricing/lookup.ts
import { findRate, loadPriceSnapshot, type PriceSnapshot } from '../../pricing/snapshot';

export interface Rate {
  usd: number;
  sku: string;
  unit: string;
  priceSource: { file: string; priceListVersion: string; capturedAt: string };
}

/** Null when the snapshot has no exact match. Never returns a near match or another region. */
export function rateFor(
  snapshot: PriceSnapshot,
  query: { serviceId: string; region: string; attributes: Record<string, string> }
): Rate | null;

/** Graduated rates for one usage type, ascending by `fromUnit`. Empty when none match. */
export function tieredRatesFor(
  snapshot: PriceSnapshot,
  query: { serviceId: string; region: string; attributes: Record<string, string> }
): Rate[];

export { loadPriceSnapshot };
```

`priceSource` stays a single object rather than becoming a list because each kind here reads exactly
one offer file: `AWSELB` for the load balancer, `AmazonCloudFront` for the distribution, `AmazonEC2`
for the NAT gateway. A kind that needed two offers would need the field to be plural, and none does.

Data transfer attribution, the part that must not be reinvented per kind:

```typescript
// packages/core/src/resources/data-transfer.ts
import type { EgressClass, UsageAssumptions } from './contract';

export interface EgressAttribution {
  nodeId: string;
  egressClass: EgressClass;
  gbPerMonth: number;
  assumptionIds: string[];
  /** One sentence naming why this node owns these bytes, shown next to the cost line. */
  basis: string;
}

export interface AttributionResult {
  byNode: Map<string, EgressAttribution[]>;
  /** Gigabytes no node owns, for example internet egress in an architecture with no edge. */
  unattributedGb: number;
  /** Plain-language notes, including every share that was split evenly for want of a weight. */
  notes: string[];
}

/** Pure over the document and the assumptions. Never reads a price. */
export function attributeDataTransfer(
  ir: ArchitectureIr,
  usage: UsageAssumptions
): AttributionResult;
```

The rules, in order, so two implementations cannot differ:

1. The internet-facing set is every `cloudfront_distribution`, plus every `alb` with
   `scheme: 'internet-facing'` that has no inbound `routes_to` edge from a `cloudfront_distribution`.
2. `egress.internetGbPerMonth` is divided across that set in proportion to
   `edge.egressShare.<nodeId>` when those assumptions are supplied, and evenly otherwise, with the
   even split recorded in `notes` and each share declared as an editable assumption. A guess that is
   visible is arguable; a guess inside a formula is not.
3. A `cloudfront_distribution` additionally owns `origin-fetch` bytes equal to its internet share
   times `(1 - cdn.cacheHitRatio)`. Those bytes are priced from the CloudFront offer's
   origin-fetch rate, which is 0.00 USD per GB for an AWS origin, and the line is emitted at zero
   rather than omitted so a reader can see the transfer was considered.
4. An `alb` behind a distribution owns no `internet` bytes. It still counts every byte in its LCU
   processed-bytes dimension, because an LCU is charged on traffic through the load balancer whoever
   pays the transfer. This is the asymmetry every double-count comes from, and it is why rule 2 keys
   on ownership rather than on traversal.
5. `egress.privateSubnetInternetGbPerMonth` is owned by the `nat_gateway` whose `routedSubnetIds`
   contains the sending node's nearest subnet ancestor, as `nat-processed`. A private subnet with no
   NAT gateway contributes to `unattributedGb` with a note, never to zero.
6. `traffic.crossAzGbPerMonth` is owned by the sending node as `inter-az`.
7. Conservation: for each of `internet` and `nat-processed`, the sum of attributed gigabytes plus
   `unattributedGb` equals the assumption total to within 1e-9.

The three kinds are typed in the schema, with `params` factored into its own `$defs` entry so
`paramsDef` has a name to point at -- `010-architecture-ir-schema.md` inlines `params` inside each
node branch, which leaves that field with nothing to name. The `vpc` and `subnet` branches are left
as they are. The parameters, given as the TypeScript that
`docs/issues/epic-2-ir/020-ir-type-generation.md` must generate, with every schema branch declaring
`additionalProperties: false`:

```typescript
// $defs: albParams, referenced by albNode
export interface AlbParams {
  scheme: 'internet-facing' | 'internal';
  /** Subnet node ids, at least two, in distinct availability zones. Required. */
  subnetIds: string[];
  ipAddressType: 'ipv4' | 'dualstack';
  idleTimeoutSeconds: number;
  http2Enabled: boolean;
  listeners: AlbListener[];
  deletionProtection: boolean;
  /** `s3_bucket` node id, or null when access logging is off. */
  accessLogsBucketId: string | null;
  wafWebAclArn: string | null;
}

export interface AlbListener {
  port: number;
  protocol: 'HTTP' | 'HTTPS';
  certificateArn: string | null;
  action: 'forward' | 'redirect-to-https';
  /** Node id of the target, or null for a listener that only redirects. */
  targetNodeId: string | null;
  healthCheckPath: string;
}

// $defs: cloudfrontDistributionParams
export interface CloudfrontDistributionParams {
  priceClass: 'PriceClass_100' | 'PriceClass_200' | 'PriceClass_All';
  /** Node id of the origin: an `s3_bucket` or an `alb`. */
  originNodeId: string;
  originAccess: 'origin-access-control' | 'public' | 'custom';
  viewerProtocolPolicy: 'allow-all' | 'redirect-to-https' | 'https-only';
  defaultRootObject: string;
  defaultTtlSeconds: number;
  compress: boolean;
  httpVersion: 'http2' | 'http2and3';
  wafWebAclArn: string | null;
  loggingBucketId: string | null;
}

// $defs: natGatewayParams
export interface NatGatewayParams {
  connectivityType: 'public' | 'private';
  /** Public subnet node id this gateway sits in. */
  subnetId: string;
  /** Private subnet node ids whose default route points here. May be empty. */
  routedSubnetIds: string[];
}
```

`subnetIds` on the ALB is a list even though containment already gives the node a parent, because a
load balancer requires subnets in at least two availability zones and an IR node has exactly one
`parent`. The parent stays the subnet the canvas renders it inside, and `validateIr` gains one
referential rule: every id in `subnetIds` names a `subnet` node, and `parent` is one of them. The
alternative -- inferring the AZ set from sibling subnets in the same VPC -- would make the
availability answer depend on subnets the load balancer is not attached to.

Cost dimensions, each with the offer code, the product family and the attribute filter the lookup
matches on. The `usagetype` strings are recorded verbatim from the offer file during implementation
and asserted in the fixture; a contract must not pattern-match on a guessed usage type.

| Kind                      | Offer              | Dimension           | Unit       | Attribute filter                                 |
| ------------------------- | ------------------ | ------------------- | ---------- | ------------------------------------------------ |
| `alb`                     | `AWSELB`           | Load balancer hours | `Hrs`      | `productFamily: Load Balancer-Application`       |
| `alb`                     | `AWSELB`           | LCU hours           | `LCU-Hrs`  | `operation: LoadBalancing:Application`           |
| `cloudfront_distribution` | `AmazonCloudFront` | Data transfer out   | `GB`       | `productFamily: Data Transfer`, graduated        |
| `cloudfront_distribution` | `AmazonCloudFront` | HTTPS requests      | `Requests` | `productFamily: Request`, `requestType: HTTPS`   |
| `cloudfront_distribution` | `AmazonCloudFront` | Origin fetch        | `GB`       | `productFamily: Data Transfer`, origin direction |
| `nat_gateway`             | `AmazonEC2`        | Gateway hours       | `Hrs`      | `productFamily: NAT Gateway`, `usagetype` hours  |
| `nat_gateway`             | `AmazonEC2`        | Data processed      | `GB`       | `productFamily: NAT Gateway`, `usagetype` bytes  |

The LCU is the dimension everyone gets wrong, so the model is written out. An LCU covers 25 new
connections per second, 3,000 active connections per minute, 1GB of processed bytes per hour and
1,000 rule evaluations per second, and the charge is the **maximum** of the four dimensions rather
than their sum. Each dimension is computed from an assumption, the maximum is taken, and the losing
dimensions are reported in the component's `basis` so a user can see which one binds. Source:
https://aws.amazon.com/elasticloadbalancing/pricing/, read 2026-08-10.

Latency contributions, each with the basis string it must carry:

- `alb`: 1.5ms p50, 4ms p95, from `DEFAULT_SERVICE_TIMES_MS.alb` in
  `docs/issues/epic-7-prediction/030-latency-model.md`, plus 0ms for a same-AZ target and the
  cross-AZ round trip when `subnetIds` spans zones and the target does not.
- `cloudfront_distribution`: 10ms p50 on a cache hit; on a miss the contribution is the edge hop plus
  the origin fetch, so p95 is computed from `cdn.cacheHitRatio` rather than fixed. A distribution
  with `defaultTtlSeconds: 0` therefore reports a higher p50 than no distribution at all, which is
  the point.
- `nat_gateway`: 0.5ms p50, 1ms p95, and only on a path that leaves a private subnet.

Reliability, with the published SLA where one exists:

| Kind                      | Configuration | Availability | Basis     | Source                                                                |
| ------------------------- | ------------- | ------------ | --------- | --------------------------------------------------------------------- |
| `alb`                     | `multi-az`    | 0.9999       | published | https://aws.amazon.com/elasticloadbalancing/sla/                      |
| `alb`                     | `single-az`   | 0.99         | modelled  | no commitment covers one zone; SPOF                                   |
| `cloudfront_distribution` | `global`      | 0.999        | published | https://aws.amazon.com/cloudfront/sla/                                |
| `nat_gateway`             | `zonal`       | 0.9995       | modelled  | https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html |

AWS publishes no NAT gateway SLA, so its figure is `modelled` and says so, and a gateway with
`routedSubnetIds` outside its own zone reports `singlePointOfFailure: true`. Inventing a published
number here is the exact failure `050-availability-and-slo.md` argues against. Every SLA value is
re-read from the cited page at implementation time and the `retrievedAt` date set to that day.

`azCount` is 0 for a resource whose placement the IR does not express, which is what a
`cloudfront_distribution` is: it has no subnet and no zone. Zero means the availability model uses the
published figure as a series component and never applies the parallel-replica formula to it, and one
means zonal. Every later kind with a regional or global control plane reports the same 0 for the same
reason.

The Well-Architected rules, stated so they are not reinvented:

- `ALB-REL-001` (reliability, high): `subnetIds` resolves to fewer than two distinct
  `availabilityZone` values. Pointer `/params/subnetIds`.
- `ALB-SEC-001` (security, high): a listener with `protocol: 'HTTP'` and `action: 'forward'`.
  Pointer `/params/listeners/<i>/protocol`.
- `ALB-SEC-002` (security, medium): `scheme: 'internet-facing'` with `wafWebAclArn` null. Pointer
  `/params/wafWebAclArn`.
- `ALB-OPS-001` (operational-excellence, medium): `accessLogsBucketId` is null, so there is no
  request record to debug an incident with. Pointer `/params/accessLogsBucketId`.
- `ALB-COST-001` (cost-optimisation, low): every listener target is a `lambda_function`, which an
  HTTP API serves for less than the load balancer's fixed hourly charge. Pointer `/params/listeners`.
- `CF-SEC-001` (security, high): `viewerProtocolPolicy: 'allow-all'`. Pointer
  `/params/viewerProtocolPolicy`.
- `CF-SEC-002` (security, high): the origin resolves to an `s3_bucket` and `originAccess` is not
  `origin-access-control`, which requires the bucket to be publicly readable. Uses
  `context.targets`. Pointer `/params/originAccess`.
- `CF-PERF-001` (performance-efficiency, medium): `defaultTtlSeconds` is 0, so the distribution adds
  a hop and pays request pricing while caching nothing. Pointer `/params/defaultTtlSeconds`.
- `CF-SUS-001` (sustainability, low): `compress` is false. Pointer `/params/compress`.
- `NAT-REL-001` (reliability, high): a subnet in `routedSubnetIds` has an `availabilityZone`
  different from the gateway's own subnet, so that zone loses egress when this one fails. Pointer
  `/params/routedSubnetIds`.
- `NAT-COST-001` (cost-optimisation, medium): a node in a routed subnet has an edge to an
  `s3_bucket` or a `dynamodb_table`, so that traffic pays NAT data processing. The remediation names
  a gateway VPC endpoint and states that the IR has no kind for one yet, so this rule reports rather
  than checks. Pointer `/params/routedSubnetIds`.
- `NAT-COST-002` (cost-optimisation, low): `routedSubnetIds` is empty. Pointer
  `/params/routedSubnetIds`.

Declared assumptions, which the estimate panel renders as editable fields:

```typescript
// alb
{ id: 'traffic.newConnectionsPerSecond', unit: 'connections/s', defaultValue: 20, min: 0, max: null }
{ id: 'traffic.activeConnectionsPerMinute', unit: 'connections/min', defaultValue: 1200, min: 0 }
{ id: 'traffic.rulesEvaluatedPerRequest', unit: 'rules', defaultValue: 2, min: 1, max: 100 }
// cloudfront_distribution
{ id: 'cdn.cacheHitRatio', unit: 'fraction', defaultValue: 0.85, min: 0, max: 1 }
{ id: 'edge.egressShare.<nodeId>', unit: 'fraction', defaultValue: 1, min: 0, max: 1 }
// nat_gateway
{ id: 'egress.privateSubnetInternetGbPerMonth', unit: 'GB', defaultValue: 20, min: 0, max: null }
{ id: 'traffic.crossAzGbPerMonth', unit: 'GB', defaultValue: 0, min: 0, max: null }
```

`egress.internetGbPerMonth`, `traffic.requestsPerMonth` and `time.hoursPerMonth` are already declared
in `docs/issues/epic-7-prediction/020-cost-model.md` and are referenced by id, not redeclared.
Registration fails when two contracts declare the same id with different defaults.

`emitPulumi` output per kind: `aws.lb.LoadBalancer` plus one `aws.lb.TargetGroup` and one
`aws.lb.Listener` per listener, with `targetGroup` and `listener` declared in `secondaryRefs` so the
compute contracts in `060-compute-contracts.md` can attach to them;
`aws.cloudfront.Distribution` plus an `aws.cloudfront.OriginAccessControl` when `originAccess` is
`origin-access-control`; `aws.ec2.NatGateway` plus its `aws.ec2.Eip` when `connectivityType` is
`public`, and one `aws.ec2.Route` per routed subnet.

### Files

- MODIFY `packages/core/src/resources/contract.ts` - `AssumptionRequirement`, `CostTier`, the
  `CostComponent`, `ReliabilityContribution`, `RuleContext`, `EmitContext` and `ResourceContract`
  additions above
- MODIFY `packages/core/src/resources/registry.ts` - reject a duplicate assumption id and an
  undeclared secondary ref at registration
- MODIFY `packages/core/src/resources/rds-instance/reliability.ts` - satisfy the widened
  `ReliabilityContribution` and the new `reliability(params, context)` signature
- MODIFY `packages/core/src/resources/rds-instance/cost.ts` - carry `sku` and `assumptionIds` on its
  existing components. Do not change which rates it reads
- CREATE `packages/core/src/resources/pricing/lookup.ts`
- CREATE `packages/core/src/resources/pricing/lookup.test.ts`
- CREATE `packages/core/src/resources/data-transfer.ts`
- CREATE `packages/core/src/resources/data-transfer.test.ts`
- CREATE `packages/core/src/resources/alb/index.ts`
- CREATE `packages/core/src/resources/alb/cost.ts`
- CREATE `packages/core/src/resources/alb/lcu.ts` - the four LCU dimensions and their maximum
- CREATE `packages/core/src/resources/alb/latency.ts`
- CREATE `packages/core/src/resources/alb/reliability.ts`
- CREATE `packages/core/src/resources/alb/rules.ts`
- CREATE `packages/core/src/resources/alb/emit.ts`
- CREATE `packages/core/src/resources/alb/alb.test.ts`
- CREATE `packages/core/src/resources/alb/__golden__/edge.alb.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/index.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/cost.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/latency.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/reliability.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/rules.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/emit.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/cloudfront.test.ts`
- CREATE `packages/core/src/resources/cloudfront-distribution/__golden__/edge.cloudfront.ts`
- CREATE `packages/core/src/resources/nat-gateway/index.ts`
- CREATE `packages/core/src/resources/nat-gateway/cost.ts`
- CREATE `packages/core/src/resources/nat-gateway/latency.ts`
- CREATE `packages/core/src/resources/nat-gateway/reliability.ts`
- CREATE `packages/core/src/resources/nat-gateway/rules.ts`
- CREATE `packages/core/src/resources/nat-gateway/emit.ts`
- CREATE `packages/core/src/resources/nat-gateway/nat-gateway.test.ts`
- CREATE `packages/core/src/resources/nat-gateway/__golden__/edge.nat.ts`
- CREATE `packages/core/src/resources/__fixtures__/price-snapshot.edge.json` - the `PriceSnapshot`
  subset these tests price against, with each rate's SKU, offer version and publication date
- CREATE `packages/ir-schema/fixtures/edge-cdn-alb.json` - distribution, ALB across two subnets, NAT
  gateway, used by the round-trip and validator tests
- MODIFY `packages/ir-schema/schema/architecture-ir.schema.json` - type `alb`,
  `cloudfront_distribution` and `nat_gateway`, add their `params` `$defs`, drop the three from
  `pendingContractNode`, add the `subnetIds` referential rule
- MODIFY `packages/ir-schema/src/validate.ts` - the ALB subnet reference rule
- MODIFY `packages/ir-schema/VERSION` - minor bump
- MODIFY `packages/ir-schema/src/generated/types.ts` - regenerated
- MODIFY `services/brain/src/brain/ir/models.py` - regenerated
- MODIFY `packages/core/src/index.ts` - export the three contracts, the attribution function and the
  new contract types
- MODIFY `packages/core/src/resources/README.md` - the price lookup helper and the attribution rules

### Acceptance Criteria

- [ ] A load balancer priced for 730 hours reports separate `Hrs` and `LCU-Hrs` components whose `monthlyUsd` values sum to the total
- [ ] The LCU component reports the maximum of the four dimensions, and names the binding dimension in its `basis`
- [ ] A CloudFront data transfer component above the first tier carries `tiers` whose quantities sum to `quantity` and whose totals sum to `monthlyUsd`
- [ ] The origin fetch line is present with `monthlyUsd: 0` for an AWS origin rather than omitted
- [ ] Every cost component carries a non-empty `sku` and the assumption ids its quantity came from
- [ ] `attributeDataTransfer` attributes each gigabyte of `egress.internetGbPerMonth` to exactly one node, and the attributed total plus `unattributedGb` equals the assumption
- [ ] An ALB behind a CloudFront distribution is attributed no `internet` gigabytes and still reports processed bytes in its LCU dimension
- [ ] An architecture with a private subnet and no NAT gateway reports the private egress in `unattributedGb` with a note, not as zero
- [ ] An even egress split across two edges is recorded in `notes` and each share is declared as an editable assumption
- [ ] `reliability` reports `basis: 'published'` with the SLA URL for a two-AZ ALB and `basis: 'modelled'` for a NAT gateway
- [ ] A single-AZ ALB reports `azCount: 1` and `singlePointOfFailure: true`
- [ ] `ALB-REL-001` fires when both subnets resolve to the same availability zone
- [ ] `CF-SEC-002` fires when the origin is an S3 bucket without origin access control, and does not fire when `context.targets` is empty
- [ ] `NAT-REL-001` fires for a routed subnet in another availability zone
- [ ] Every rule returns null rather than throwing when a parameter or a neighbour is absent
- [ ] A region absent from the snapshot produces `unpriced` entries naming the region, and no component priced from another region
- [ ] `emitPulumi` output matches each `__golden__` file byte for byte
- [ ] `refFor(albId, 'targetGroup')` resolves, and `refFor(albId, 'nope')` throws
- [ ] Regenerating types after the schema change leaves the working tree clean

### Required Tests

- `prices a load balancer for a month of hours and lcus`
- `charges the maximum lcu dimension rather than the sum`
- `prices a distribution across the graduated data transfer tiers`
- `prices a nat gateway for hours and processed gigabytes`
- `matches the published price scenario for a load balancer` - 730 hours at the fixture rate of
  0.0225 USD per hour is 16.43 USD before LCUs, asserted to the cent and traceable to the SKU
  recorded in the fixture
- `matches the published price scenario for a nat gateway` - 730 hours at 0.045 USD plus 100GB
  processed at 0.045 USD is 37.35 USD, asserted to the cent
- `matches the published price scenario for a distribution` - 100GB out at 0.085 USD plus one million
  HTTPS requests at 0.01 USD per ten thousand is 9.50 USD, asserted to the cent
- `charges every gigabyte of internet egress exactly once`
- `moves internet egress ownership to cloudfront when it fronts the load balancer`
- `prices the origin fetch at the published zero rate rather than omitting the line`
- `reports unattributed egress when no edge resource owns it`
- `splits egress evenly across two edges and records the split as a note`
- `flags a load balancer whose subnets are in one availability zone`
- `flags an http listener that forwards instead of redirecting`
- `flags a distribution whose origin bucket is reachable without origin access control`
- `flags a nat gateway that another zone routes through`
- `returns null from every rule when the parameter it reads is absent`
- `reports the region as unpriced rather than substituting another region`
- `emits pulumi matching the golden files`
- `throws when a listener target names a node the document does not contain`
- `throws when refFor is asked for an undeclared secondary resource`

### Performance Budget

Cost, latency, reliability, every rule and one `attributeDataTransfer` pass for a 200-node document
complete in under 50ms, measured with `performance.now()` in `data-transfer.test.ts`, holding the
budget `040-resource-contract-registry.md` set. Attribution is one pass over nodes and one over
edges, so it is linear in the document rather than quadratic in the edge set; a test asserts the
200-node time is within 3x the 50-node time.

### Out of Scope

- Do not implement contracts for the compute, data or machine-learning kinds. Those are
  `060-compute-contracts.md`, `070-data-store-contracts.md` and `080-machine-learning-contracts.md`
- Do not migrate the RDS contract off `packages/core/src/resources/pricing/rds-us-east-1.json` onto
  the shared snapshot. It is a follow-up issue of its own so that this diff does not change a landed
  contract's figures
- Do not add `nlb`, `api_gateway`, `internet_gateway` or `route53_zone`. They are adjacent and will
  look cheap to add; each needs its own cost dimensions and rules
- Do not add a `vpc_endpoint` kind to the schema to make `NAT-COST-001` checkable. Reporting is the
  specified behaviour
- Do not change `packages/core/src/analysis/architecture.ts` to start proposing a NAT gateway. The
  contract makes the omission visible; changing the proposal changes every architecture fixture and
  belongs with the rule engine
- Do not touch `packages/core/src/codegen/pulumi.ts` or `terraform.ts`. The `switch` generators keep
  working until every kind has an emitter, which is the codegen epic (#9)
- Do not extend `packages/core/src/aws-services.ts`; every kind here already has a catalogue entry
- Do not add cost or rule endpoints to `apps/api`, and do not build the estimate panel

### Dependencies

Blocked by `docs/issues/epic-2-ir/040-resource-contract-registry.md` for the contract and the
registry, and by `docs/issues/epic-7-prediction/010-price-list-snapshot.md` (#8) for
`loadPriceSnapshot` and `findRate`. The snapshot's attribute whitelist must already carry
`productFamily`, `operation` and `requestType`, or this issue extends it. Consumed by
`docs/issues/epic-7-prediction/020-cost-model.md` and
`docs/issues/epic-7-prediction/050-availability-and-slo.md` (#8).

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
