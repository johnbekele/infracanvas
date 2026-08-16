---
title: '[ir] Resource contracts for S3, DynamoDB and ElastiCache'
labels: tier:2, size:l, area:ir, epic:2-ir
---

### Epic

#3

### Context

These three kinds have the widest gap between a naive estimate and a real bill, and the gap is always
the same shape: the storage line is small and obvious, and the request line is large and invisible.
Fifty gigabytes in S3 Standard is a bit over a dollar a month; ten million GET requests against it is
four dollars, and a million PUTs is five, so an estimate that prices storage and skips requests is off
by an order of magnitude in the direction that makes an architecture look free. DynamoDB is worse,
because on-demand and provisioned capacity are different pricing models rather than different rates,
and an item just over 1KB costs twice as much to write as an item just under it. ElastiCache is the
opposite failure: it is priced entirely in node hours that have nothing to do with traffic, so the
only question that matters is whether the node type can hold the working set, and nothing in the
current canvas asks it.

Every one of those figures depends on something nobody knows yet, which is why the three are one
issue. Requests per second, average object size, average item size and working set are user
assumptions, and this issue's real contribution is that each of them arrives through
`declaredAssumptions` and is therefore rendered as an editable field by the estimate panel, instead of
being a constant inside a cost function. A hidden constant is worse than a wrong number: a user who
sees five million requests a month can say "we do fifty" and watch the total move, and a user who sees
only a total can only distrust it. The rejected alternative was to derive request counts from
`traffic.requestsPerMonth` alone, which sounds tidy and is wrong -- one application request is not one
DynamoDB read, and the multiplier between them is exactly the thing worth exposing. So
`data.readsPerRequest` and `data.writesPerRequest` exist as declared assumptions with defaults, and
the derivation from application traffic is visible arithmetic rather than an identity.

**Two things the contract interface cannot express.** First, `AssumptionRequirement` as
`docs/issues/epic-2-ir/050-edge-and-network-contracts.md` defines it has bounds, and that is enough
for a fraction, but not for a value the panel must not submit as zero: average item size divides in
the capacity-unit calculation, so `min` has to be exclusive rather than inclusive. It gains
`exclusiveMin`. Second, `ReliabilityContribution` describes availability, and the headline reliability
property of an S3 bucket is durability -- eleven nines, an entirely different quantity from the 99.9%
availability its SLA commits to. Conflating them tells a user their data is safe when the SLA promises
only that they can reach it, so the interface gains an optional `durabilityNines`. The rejected
alternative was to state durability in the `basis` string, which puts a number a report wants to
render inside prose no report can parse.

**On-demand versus provisioned is a branch in the cost model, not a rate lookup.** A DynamoDB table
with `billingMode: 'PAY_PER_REQUEST'` is priced per read and write request unit; the same table
provisioned is priced per capacity unit hour, plus autoscaling behaviour this issue does not model.
The two produce different component sets from the same traffic assumptions, and the model reports
which mode it priced in each component's basis so the two are never confused in a comparison. Where
the mode is provisioned and `readCapacityUnits` is below the demand the assumptions imply, the
shortfall is a Well-Architected finding rather than a silently throttled estimate, because a
provisioned table that cannot serve its own traffic is a latency and error-rate problem the cost
figure would otherwise hide.

Spec: `docs/issues/epic-2-ir/040-resource-contract-registry.md`

### Contract

The additive changes to the shared contract module, on top of
`docs/issues/epic-2-ir/050-edge-and-network-contracts.md` and
`docs/issues/epic-2-ir/060-compute-contracts.md`:

```typescript
// packages/core/src/resources/contract.ts
export interface AssumptionRequirement {
  id: string;
  label: string;
  unit: string;
  defaultValue: number;
  min: number;
  max: number | null;
  /** True when `min` itself is not a legal value, for a quantity that divides. */
  exclusiveMin: boolean;
  rationale: string;
}

export interface ReliabilityContribution {
  // ... members from 050 unchanged ...
  /** Nines of durability, where 11 means 99.999999999%. Absent when the concept does not apply. */
  durabilityNines?: number;
}
```

`PriceUnit` gains the two capacity-unit members DynamoDB is billed in:

```typescript
// packages/core/src/pricing/snapshot.ts
export type PriceUnit =
  | 'Hrs'
  | 'GB-Mo'
  | 'GB'
  | 'Requests'
  | 'IOPS-Mo'
  | 'ACU-Hr'
  | 'LCU-Hrs'
  | 'vCPU-Hours'
  | 'GB-Hours'
  | 'GB-Seconds'
  | 'ReadRequestUnits' // DynamoDB on-demand reads
  | 'WriteRequestUnits' // DynamoDB on-demand writes
  | 'ReadCapacityUnit-Hrs' // DynamoDB provisioned reads
  | 'WriteCapacityUnit-Hrs'; // DynamoDB provisioned writes
```

The three kinds are typed in the schema with `params` in their own `$defs`. The parameters:

```typescript
// $defs: s3BucketParams
export interface S3BucketParams {
  storageClass: 'STANDARD' | 'STANDARD_IA' | 'INTELLIGENT_TIERING' | 'GLACIER_IR';
  versioning: boolean;
  encryption: 'SSE-S3' | 'SSE-KMS';
  /** Null when encryption is SSE-S3. */
  kmsKeyArn: string | null;
  blockPublicAccess: boolean;
  /** Static website hosting, which requires public read or a CloudFront origin access control. */
  staticHosting: boolean;
  /** Days after which objects transition, or null for no lifecycle rule. */
  lifecycleTransitionDays: number | null;
  lifecycleExpirationDays: number | null;
  accessLogging: boolean;
}

// $defs: dynamodbTableParams
export interface DynamodbTableParams {
  billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
  partitionKey: { name: string; type: 'S' | 'N' | 'B' };
  sortKey: { name: string; type: 'S' | 'N' | 'B' } | null;
  /** Required when `billingMode` is PROVISIONED, and rejected otherwise, by the validator. */
  readCapacityUnits: number | null;
  writeCapacityUnits: number | null;
  /** Strong reads cost twice an eventually consistent read, so this changes the estimate. */
  consistentReads: boolean;
  pointInTimeRecovery: boolean;
  deletionProtection: boolean;
  streamViewType: 'NEW_IMAGE' | 'NEW_AND_OLD_IMAGES' | 'KEYS_ONLY' | null;
  timeToLiveAttribute: string | null;
  globalSecondaryIndexes: { name: string; projection: 'ALL' | 'KEYS_ONLY' | 'INCLUDE' }[];
  /** Replica regions. A non-empty list is a global table, which has its own SLA. */
  replicaRegions: string[];
}

// $defs: elasticacheClusterParams
export interface ElasticacheClusterParams {
  engine: 'redis' | 'valkey' | 'memcached';
  nodeType: string;
  /** Nodes in the primary shard group, including the primary itself. */
  nodeCount: number;
  /** Redis and Valkey only. Automatic failover requires at least one replica. */
  automaticFailover: boolean;
  multiAz: boolean;
  transitEncryption: boolean;
  atRestEncryption: boolean;
  /** Subnet node ids the nodes are placed in. */
  subnetIds: string[];
  /** `noeviction`, `allkeys-lru`, and the rest. Changes what happens when the working set overflows. */
  evictionPolicy: 'noeviction' | 'allkeys-lru' | 'allkeys-lfu' | 'volatile-lru' | 'volatile-ttl';
  snapshotRetentionDays: number;
}
```

`readCapacityUnits` and `writeCapacityUnits` being required exactly when `billingMode` is
`PROVISIONED` is a validator rule rather than a JSON Schema `if`/`then`, for the same reason the
Fargate size pairing is: the schema's failure message would point at the wrong property.

Cost dimensions, with the offer code and the attribute filter. Usage types are copied verbatim from
the offer file at implementation time and recorded in the fixture:

| Kind                  | Offer               | Dimension               | Unit                    | Attribute filter                                               |
| --------------------- | ------------------- | ----------------------- | ----------------------- | -------------------------------------------------------------- |
| `s3_bucket`           | `AmazonS3`          | Storage                 | `GB-Mo`                 | `productFamily: Storage`, `storageClass`, graduated            |
| `s3_bucket`           | `AmazonS3`          | PUT, COPY, POST, LIST   | `Requests`              | `productFamily: API Request`, tier-1 group                     |
| `s3_bucket`           | `AmazonS3`          | GET and all other       | `Requests`              | `productFamily: API Request`, tier-2 group                     |
| `s3_bucket`           | `AmazonS3`          | Lifecycle transitions   | `Requests`              | `productFamily: API Request`, transition group                 |
| `dynamodb_table`      | `AmazonDynamoDB`    | On-demand reads         | `ReadRequestUnits`      | `productFamily: Amazon DynamoDB PayPerRequest Throughput`      |
| `dynamodb_table`      | `AmazonDynamoDB`    | On-demand writes        | `WriteRequestUnits`     | same family, write direction                                   |
| `dynamodb_table`      | `AmazonDynamoDB`    | Provisioned read units  | `ReadCapacityUnit-Hrs`  | `productFamily: Provisioned IOPS`, read                        |
| `dynamodb_table`      | `AmazonDynamoDB`    | Provisioned write units | `WriteCapacityUnit-Hrs` | same family, write direction                                   |
| `dynamodb_table`      | `AmazonDynamoDB`    | Table storage           | `GB-Mo`                 | `productFamily: Database Storage`                              |
| `elasticache_cluster` | `AmazonElastiCache` | Node hours              | `Hrs`                   | `productFamily: Cache Instance`, `cacheEngine`, `instanceType` |
| `elasticache_cluster` | `AmazonElastiCache` | Backup storage          | `GB-Mo`                 | `productFamily: Storage Snapshot`                              |

The quantities, written out because the rounding is where the money is:

```
s3 storage GB-Mo      = storage.objectGb                        (graduated tiers)
s3 tier-1 requests    = data.writeRequestsPerSecond * 2_592_000
s3 tier-2 requests    = data.readRequestsPerSecond  * 2_592_000

ddb on-demand WRU     = writes * ceil(data.averageItemKb / 1)   one WRU per 1KB, rounded up
ddb on-demand RRU     = reads  * ceil(data.averageItemKb / 4)
                        * (consistentReads ? 1 : 0.5)           4KB per strong read, half for
                                                                eventually consistent
ddb provisioned RCU-h = readCapacityUnits  * time.hoursPerMonth
ddb provisioned WCU-h = writeCapacityUnits * time.hoursPerMonth
ddb storage GB-Mo     = storage.tableGb, first 25GB free is NOT applied (see below)

cache node hours      = nodeCount * time.hoursPerMonth
cache backup GB-Mo    = snapshotRetentionDays > 0 ? cache.workingSetGb : 0
```

Rounding up per item is not a detail: at an average item size of 1.1KB every write costs two write
request units, so a model that multiplies by 1.1 reports a bill 45% under the real one. The rounding
is applied per item, not to the monthly total, and a test pins the boundary at exactly 1.0KB and
1.01KB.

Free tiers are deliberately not applied, matching the Out of Scope in
`docs/issues/epic-7-prediction/020-cost-model.md`. DynamoDB's first 25GB and S3's first 5GB are
account-wide rather than per-resource, so applying them per table produces a total that is wrong for
every account with more than one table, and the amount involved is a few dollars. Each cost estimate
notes the omission in the affected component's basis so the difference from the AWS calculator is
explained rather than mysterious.

Latency contributions:

- `s3_bucket`: 25ms p50 and 60ms p95 for a first-byte GET, from `DEFAULT_SERVICE_TIMES_MS.s3`, plus
  a size term of `averageObjectKb / data.throughputKbPerMs` for the transfer. A bucket has no queue
  that the caller can saturate, so `capacity` returns null and the contribution is `fixed`.
- `dynamodb_table`: 6ms p50 and 15ms p95 for a single-item read, from
  `DEFAULT_SERVICE_TIMES_MS.dynamodb`, doubled for a strongly consistent read because it goes to the
  leader replica. `capacity` is null for on-demand -- there is no server count a user controls -- and
  for a provisioned table returns `servers` equal to `readCapacityUnits` with `limitIds`
  `['dynamodb.partitionReadUnits', 'queue.capacity']`, so the solver can find the throttling point.
  That mapping is exact rather than an analogy: one read capacity unit is one strongly consistent 4KB
  read per second, so `c` is the unit count and `1 / mu` is one second, and the M/M/c queue the
  latency model builds from it is the throttling behaviour rather than a proxy for it.
- `elasticache_cluster`: 0.6ms p50 and 1.5ms p95 from `DEFAULT_SERVICE_TIMES_MS.elasticache`, and a
  cache is the one place where a miss dominates: p95 is computed from `cache.hitRatio`, so a cache in
  front of a database with a low hit ratio correctly reports a latency contribution worse than no
  cache. `capacity` returns `nodeCount` servers with `limitIds`
  `['elasticache.clientConnections', 'queue.capacity']`.

Reliability, with the published SLA where one exists:

| Kind                  | Configuration   | Availability | Basis     | Source                                  |
| --------------------- | --------------- | ------------ | --------- | --------------------------------------- |
| `s3_bucket`           | `standard`      | 0.999        | published | https://aws.amazon.com/s3/sla/          |
| `s3_bucket`           | `standard-ia`   | 0.99         | published | same SLA, different storage class       |
| `dynamodb_table`      | `single-region` | 0.9999       | published | https://aws.amazon.com/dynamodb/sla/    |
| `dynamodb_table`      | `global-table`  | 0.99999      | published | same SLA, replica regions present       |
| `elasticache_cluster` | `multi-az`      | 0.9999       | published | https://aws.amazon.com/elasticache/sla/ |
| `elasticache_cluster` | `single-node`   | 0.995        | modelled  | no commitment covers one node; SPOF     |

`s3_bucket` also reports `durabilityNines: 11`, and its `basis` states plainly that durability and
availability are different promises. `elasticache_cluster` reports
`singlePointOfFailure: true` unless `automaticFailover` and `multiAz` are both true with
`nodeCount >= 2`, which is the case that matters: a cache in series on the request path with no
replica lowers the whole architecture's availability, and
`docs/issues/epic-7-prediction/050-availability-and-slo.md` uses exactly that to show why adding a
cache can make things worse. Every SLA figure is re-read from the cited page at implementation time
and `retrievedAt` set to that day.

The Well-Architected rules:

- `S3-SEC-001` (security, high): `blockPublicAccess` is false. Pointer `/params/blockPublicAccess`.
- `S3-SEC-002` (security, medium): `staticHosting` is true and no `cloudfront_distribution` in
  `context.sources` uses this bucket as an origin with `origin-access-control`, so the bucket is
  serving the internet directly. Pointer `/params/staticHosting`.
- `S3-REL-001` (reliability, medium): `versioning` is false, so an overwrite or delete is
  unrecoverable. Pointer `/params/versioning`.
- `S3-COST-001` (cost-optimisation, medium): `storageClass` is `STANDARD` with no
  `lifecycleTransitionDays`, so nothing ever ages out of the most expensive class. Pointer
  `/params/lifecycleTransitionDays`.
- `S3-OPS-001` (operational-excellence, low): `accessLogging` is false. Pointer
  `/params/accessLogging`.
- `DDB-REL-001` (reliability, medium): `pointInTimeRecovery` is false. Pointer
  `/params/pointInTimeRecovery`.
- `DDB-OPS-001` (operational-excellence, medium): `deletionProtection` is false, matching
  `RDS-OPS-001` so the same mistake reads the same way in both. Pointer
  `/params/deletionProtection`.
- `DDB-PERF-001` (performance-efficiency, high): `billingMode` is `PROVISIONED` and
  `readCapacityUnits` is below the demand the read assumptions imply, so the table throttles at the
  assumed traffic. Pointer `/params/readCapacityUnits`.
- `DDB-COST-001` (cost-optimisation, medium): `billingMode` is `PAY_PER_REQUEST` while the assumed
  traffic is steady and high enough that provisioned capacity costs less, using the crossover the
  cost model already computes. Pointer `/params/billingMode`.
- `DDB-COST-002` (cost-optimisation, low): a global secondary index with `projection: 'ALL'`, which
  duplicates every attribute and therefore the storage and write cost. Pointer
  `/params/globalSecondaryIndexes/<i>/projection`.
- `CACHE-REL-001` (reliability, high): `automaticFailover` is false or `nodeCount` is 1 on a Redis or
  Valkey cluster. Pointer `/params/automaticFailover`.
- `CACHE-SEC-001` (security, high): `transitEncryption` is false, so cache traffic and anything in it
  crosses the VPC in plaintext. Pointer `/params/transitEncryption`.
- `CACHE-PERF-001` (performance-efficiency, high): the working set assumption exceeds the usable
  memory of `nodeType`, so the cache evicts continuously and the hit ratio the latency model assumed
  cannot happen. Pointer `/params/nodeType`.
- `CACHE-REL-002` (reliability, medium): `evictionPolicy` is `noeviction` while the cache is used as
  a cache rather than a store, because a full cache then returns errors instead of missing. Pointer
  `/params/evictionPolicy`.

Declared assumptions, all editable, all rendered by the estimate panel:

```typescript
// s3_bucket
{ id: 'data.readRequestsPerSecond', unit: 'requests/s', defaultValue: 5, min: 0, max: null }
{ id: 'data.writeRequestsPerSecond', unit: 'requests/s', defaultValue: 0.5, min: 0, max: null }
{ id: 'data.averageObjectKb', unit: 'KB', defaultValue: 256, min: 0, exclusiveMin: true }
{ id: 'data.throughputKbPerMs', unit: 'KB/ms', defaultValue: 10, min: 0, exclusiveMin: true }
// dynamodb_table
{ id: 'data.readsPerRequest', unit: 'reads', defaultValue: 3, min: 0, max: null }
{ id: 'data.writesPerRequest', unit: 'writes', defaultValue: 1, min: 0, max: null }
{ id: 'data.averageItemKb', unit: 'KB', defaultValue: 1, min: 0, exclusiveMin: true }
{ id: 'storage.tableGb', unit: 'GB', defaultValue: 10, min: 0, max: null }
// elasticache_cluster
{ id: 'cache.workingSetGb', unit: 'GB', defaultValue: 1, min: 0, exclusiveMin: true }
{ id: 'cache.hitRatio', unit: 'fraction', defaultValue: 0.8, min: 0, max: 1 }
```

`storage.objectGb` and `time.hoursPerMonth` are referenced from
`docs/issues/epic-7-prediction/020-cost-model.md` by id rather than redeclared. `data.readsPerRequest`
multiplied by `traffic.requestsPerMonth` is how DynamoDB traffic is derived, and each cost line names
both ids so `reviseAssumption` recomputes it when either changes.

The usable memory table `CACHE-PERF-001` and the working-set check read is data with a citation, not
a formula: ElastiCache reserves memory for overhead, so a `cache.t3.micro` with 0.5GiB of memory does
not hold a 0.5GB working set. Source:
https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html, read
2026-08-10.

`emitPulumi` per kind: `aws.s3.BucketV2` plus `aws.s3.BucketVersioningV2`,
`aws.s3.BucketServerSideEncryptionConfigurationV2`, `aws.s3.BucketPublicAccessBlock` and an
`aws.s3.BucketLifecycleConfigurationV2` when a lifecycle rule is set, with `publicAccessBlock`
declared in `secondaryRefs`; `aws.dynamodb.Table` with its indexes and replicas inline;
`aws.elasticache.ReplicationGroup` for Redis and Valkey and `aws.elasticache.Cluster` for Memcached,
plus the `aws.elasticache.SubnetGroup` both need, declared as the `subnetGroup` secondary ref. Using
the versioned `BucketV2` resources rather than the deprecated inline arguments on `aws.s3.Bucket` is
deliberate: the inline form still exists and produces provider deprecation warnings that a user will
read as our bug.

### Files

- MODIFY `packages/core/src/resources/contract.ts` - `exclusiveMin` on `AssumptionRequirement` and
  `durabilityNines` on `ReliabilityContribution`
- MODIFY `packages/core/src/pricing/snapshot.ts` - the four capacity-unit `PriceUnit` members
- MODIFY `scripts/ci/build-price-snapshot.mjs` - keep the DynamoDB throughput and S3 API request
  usage types, and the `storageClass` and `cacheEngine` attributes
- MODIFY `packages/core/src/prediction/limits/aws-limits.ts` - confirm `dynamodb.partitionReadUnits`
  and `elasticache.clientConnections` carry a source URL and a retrieval date, and add them when the
  bottleneck solver has not
- CREATE `packages/core/src/resources/s3-bucket/index.ts`
- CREATE `packages/core/src/resources/s3-bucket/cost.ts`
- CREATE `packages/core/src/resources/s3-bucket/latency.ts`
- CREATE `packages/core/src/resources/s3-bucket/reliability.ts`
- CREATE `packages/core/src/resources/s3-bucket/rules.ts`
- CREATE `packages/core/src/resources/s3-bucket/emit.ts`
- CREATE `packages/core/src/resources/s3-bucket/s3-bucket.test.ts`
- CREATE `packages/core/src/resources/s3-bucket/__golden__/data.s3.ts`
- CREATE `packages/core/src/resources/dynamodb-table/index.ts`
- CREATE `packages/core/src/resources/dynamodb-table/cost.ts`
- CREATE `packages/core/src/resources/dynamodb-table/capacity-units.ts` - the RRU and WRU rounding
- CREATE `packages/core/src/resources/dynamodb-table/latency.ts`
- CREATE `packages/core/src/resources/dynamodb-table/reliability.ts`
- CREATE `packages/core/src/resources/dynamodb-table/rules.ts`
- CREATE `packages/core/src/resources/dynamodb-table/emit.ts`
- CREATE `packages/core/src/resources/dynamodb-table/dynamodb-table.test.ts`
- CREATE `packages/core/src/resources/dynamodb-table/__golden__/data.dynamodb.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/index.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/cost.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/node-types.ts` - usable memory per node
  type, with the source URL and retrieval date
- CREATE `packages/core/src/resources/elasticache-cluster/latency.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/reliability.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/rules.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/emit.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/elasticache-cluster.test.ts`
- CREATE `packages/core/src/resources/elasticache-cluster/__golden__/data.elasticache.ts`
- CREATE `packages/core/src/resources/__fixtures__/price-snapshot.data.json` - the rates these tests
  price against, each with its SKU, offer version and publication date
- CREATE `packages/ir-schema/fixtures/data-stores.json`
- MODIFY `packages/ir-schema/schema/architecture-ir.schema.json` - type `s3_bucket`,
  `dynamodb_table` and `elasticache_cluster`, add their `params` `$defs`, drop them from
  `pendingContractNode`
- MODIFY `packages/ir-schema/src/validate.ts` - the provisioned capacity pairing rule
- MODIFY `packages/ir-schema/VERSION` - minor bump
- MODIFY `packages/ir-schema/src/generated/types.ts` - regenerated
- MODIFY `services/brain/src/brain/ir/models.py` - regenerated
- MODIFY `packages/core/src/index.ts` - export the three contracts
- MODIFY `packages/core/src/resources/README.md` - how an assumption becomes an editable input

### Acceptance Criteria

- [ ] An S3 bucket reports storage, tier-1 request and tier-2 request components whose totals sum to the monthly figure
- [ ] S3 storage above the first tier carries `tiers` whose quantities sum to `quantity`
- [ ] A DynamoDB table in `PAY_PER_REQUEST` reports request-unit components, and the same table provisioned reports capacity-unit-hour components instead, from the same assumptions
- [ ] An average item size of 1.01KB costs two write request units per write and 1.0KB costs one
- [ ] An eventually consistent read costs half a read request unit per 4KB and a strongly consistent read costs one
- [ ] Every declared assumption appears in `declaredAssumptions` with a unit, a default, bounds and a rationale, and none is read from a constant inside a cost function
- [ ] An assumption with `exclusiveMin: true` and a supplied value of 0 produces an `unpriced` entry rather than a division by zero or an infinity
- [ ] `s3_bucket` reports `durabilityNines: 11` and an availability of 0.999, and its basis distinguishes the two
- [ ] A single-node ElastiCache cluster reports `singlePointOfFailure: true`, and a Multi-AZ cluster with a replica reports false with `basis: 'published'`
- [ ] A DynamoDB table with replica regions reports the global-table SLA and one without reports the single-region SLA
- [ ] `CACHE-PERF-001` fires when `cache.workingSetGb` exceeds the usable memory of the node type
- [ ] `DDB-PERF-001` fires when provisioned read capacity is below the demand the assumptions imply
- [ ] `DDB-COST-001` fires only above the crossover the cost model computes, and the finding quotes both figures
- [ ] `capacity` returns null for an S3 bucket and for an on-demand table, and a server count for a provisioned table and a cache
- [ ] Every rule returns null rather than throwing when the parameter it reads is absent
- [ ] `emitPulumi` output matches each `__golden__` file byte for byte
- [ ] A region absent from the snapshot produces `unpriced` entries naming the region

### Required Tests

- `prices an s3 bucket from storage and both request classes`
- `matches the published price scenario for an s3 bucket` - 50GB in Standard plus one million GETs
  and one hundred thousand PUTs is 2.05 USD at the fixture rate, asserted to the cent
- `matches the published price scenario for a dynamodb table` - one million writes and four million
  eventually consistent reads of 1KB items with 10GB stored is 4.25 USD at the fixture rate,
  asserted to the cent
- `matches the published price scenario for an elasticache cluster` - two cache.t3.micro nodes for
  730 hours is 24.82 USD at the fixture rate, asserted to the cent
- `prices the same table differently on demand and provisioned`
- `rounds write request units up per item at the one kilobyte boundary`
- `halves read request units for an eventually consistent read`
- `applies the graduated storage tiers above the first tier`
- `declares every assumption it reads with bounds and a rationale`
- `reports an unpriced component instead of dividing by a zero item size`
- `reports durability and availability as separate figures`
- `treats a single node cache as a single point of failure`
- `distinguishes a global table from a single region table`
- `flags a working set larger than the node type can hold`
- `flags provisioned read capacity below the assumed demand`
- `flags on demand billing above the provisioned crossover and not below it`
- `returns null from every rule when the parameter it reads is absent`
- `returns a null capacity model for a bucket and for an on demand table`
- `emits pulumi matching the golden files`
- `reports the region as unpriced rather than substituting another region`

### Performance Budget

Cost, latency, capacity, reliability and every rule for a 200-node document complete in under 50ms,
measured with `performance.now()` in `dynamodb-table.test.ts`, holding the budget
`040-resource-contract-registry.md` set. The graduated tier walk is bounded by the number of tiers in
the snapshot, which is under ten for every dimension here, so it does not depend on the assumed
quantity.

### Out of Scope

- Do not apply free tiers, Reserved Nodes, or DynamoDB reserved capacity. `020-cost-model.md` excludes
  all three, and applying an account-wide allowance per resource is wrong for any account with two
- Do not model DynamoDB autoscaling, adaptive capacity, or the burst bucket. A provisioned table is
  priced and checked at its configured capacity
- Do not model S3 Intelligent-Tiering's monitoring charge or the transitions it makes on its own; the
  storage class is priced at its listed rate and the monitoring charge is reported as unpriced
- Do not implement `aurora`, `documentdb`, `opensearch`, `memorydb`, `efs` or `redshift`. They are in
  the catalogue, they are not IR kinds, and each needs its own dimensions
- Do not implement `sqs_queue` or `sns_topic` even though they are request-priced and would fit the
  pattern; they are integration kinds with their own throughput quotas
- Do not build the estimate panel or add an assumptions endpoint to `apps/api`. This issue declares
  the assumptions; rendering them is the web epic (#12)
- Do not touch `packages/core/src/codegen/pulumi.ts` or `terraform.ts`
- Do not migrate the RDS contract onto the shared price lookup

### Dependencies

Blocked by `docs/issues/epic-2-ir/040-resource-contract-registry.md`,
`docs/issues/epic-2-ir/050-edge-and-network-contracts.md` for the widened contract module and the
price lookup, and `docs/issues/epic-2-ir/060-compute-contracts.md` for `CapacityModel`. Blocked by
`docs/issues/epic-7-prediction/010-price-list-snapshot.md` (#8) for the snapshot, whose `PriceUnit`
union and whitelist this issue extends. Consumed by
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
