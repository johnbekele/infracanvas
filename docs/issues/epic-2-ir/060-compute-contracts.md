---
title: '[ir] Resource contracts for Fargate services and Lambda functions'
labels: tier:2, size:l, area:ir, epic:2-ir
---

### Epic

#3

### Context

`packages/core/src/analysis/architecture.ts` proposes exactly two things to run application code on:
an `ecs` node when the component ships a Dockerfile or a compose service, and an `ec2` node when it
does not. Every architecture the product generates therefore has a compute node at its centre, and
that node is the one the user cares about most, because it is where the money and the latency are.
Today it prices at nothing and contributes nothing to the latency model. This issue lands the
contracts for the two kinds a modern proposal actually uses -- an ECS service on Fargate, and a Lambda
function -- plus the minimal `ecs_cluster` contract a service needs to be deployable.

Both kinds are in one issue because they are the same question asked twice, and the answer has to be
the same shape. `docs/issues/epic-7-prediction/030-latency-model.md` models every resource as an
M/M/c service centre, and `docs/issues/epic-7-prediction/040-bottleneck-solver.md` turns residence
time into a concurrency figure and compares it against a published quota. Both need a server count
and a mean service time from the resource, and for compute those come from a capacity model rather
than from a constant: an ECS service is `desiredCount` servers each with `cpuUnits` of CPU, and a
Lambda function is `reservedConcurrency` servers each with CPU proportional to its memory setting.
Writing those two capacity models separately, in two issues, is how they end up with different
definitions of `c` and a latency model that cannot compare them.

**The contract interface cannot express a capacity model at all, and that is specified here.**
`LatencyContribution` carries `p50Ms`, `p95Ms` and a basis string, which is a fixed contribution --
exactly the load-independent model `030-latency-model.md` opens by disqualifying. There is nowhere to
put `c`, nowhere to put `1/mu`, and nowhere to name the quota that binds first, so the solver would
have to reimplement per-kind knowledge it was designed to read from the contract. `capacity` is
therefore added to `ResourceContract`, returning null for a kind with no queue. `latency` also gains
the usage assumptions, because a Lambda duration depends on the memory setting and on request size
and an ECS service time depends on task size, and a signature that takes only parameters cannot see
either. The alternative -- keeping `latency(params)` and having the prediction plane hold a table of
per-kind capacity rules -- was rejected because it puts half of each resource's model outside the
registry that exists to keep the seven parts together, and `kindsWithoutContract()` would then report
a kind as complete while its capacity model was missing.

**Cold start is a latency contribution, not a footnote.** A function whose warm p50 is 20ms and whose
cold start is 900ms has a p95 that depends entirely on how often it is cold, and reporting only the
warm figure is the kind of prediction that gets contradicted by the first load test. So
`LatencyContribution` gains an optional `coldStart`, populated for `lambda_function` from the runtime
and from an editable share assumption, and suppressed when provisioned concurrency is configured --
which is also what makes the provisioned concurrency cost line worth paying for, so the two answers
stay consistent.

**Quotas are named, not discovered.** The service quota that binds under load is the whole reason an
architecture that looks fine falls over, and for these two kinds it is not the queueing capacity: a
Fargate service hits the region's On-Demand vCPU count long before its task count matters, and a
Lambda function hits regional concurrent executions long before its own duration does. Each contract
declares the limit ids it participates in, and this issue adds the entries to the table
`040-bottleneck-solver.md` defines rather than inventing a second place for limits.

Spec: `docs/issues/epic-2-ir/040-resource-contract-registry.md`

### Contract

The additive changes to the shared contract module, on top of the ones
`docs/issues/epic-2-ir/050-edge-and-network-contracts.md` makes:

```typescript
// packages/core/src/resources/contract.ts
export interface CapacityModel {
  /** `c` in M/M/c. Task count for a service, concurrent executions for a function. */
  servers: number;
  /** `1 / mu` in milliseconds, after scaling for the size of one server. */
  serviceTimeMs: number;
  /** vCPU and memory per server. Null for a kind whose size is not expressed that way. */
  vcpuPerServer: number | null;
  memoryMbPerServer: number | null;
  /** True when `servers` grows with load rather than being fixed, so the solver can say so. */
  elastic: boolean;
  /** Ids in `AWS_LIMITS`, in the order they usually bind. */
  limitIds: string[];
  /** How `serviceTimeMs` was scaled, shown next to the prediction. */
  basis: string;
  assumptionIds: string[];
}

export interface LatencyContribution {
  p50Ms: number;
  p95Ms: number;
  basis: string;
  /** Present when a share of requests pays an initialisation cost. */
  coldStart?: {
    p50Ms: number;
    p95Ms: number;
    /** Fraction of requests that are cold. Zero when provisioned capacity removes them. */
    shareOfRequests: number;
    assumptionIds: string[];
  };
}

export interface ResourceContract<K extends ResourceKind> {
  // ... unchanged members ...
  /** Usage is needed because duration depends on request size and on server size. */
  latency(params: ParamsOf<K>, usage: UsageAssumptions): LatencyContribution;
  /** Null for a kind with no queue, for example an S3 bucket. */
  capacity(params: ParamsOf<K>, usage: UsageAssumptions): CapacityModel | null;
}
```

The price snapshot's `PriceUnit` union has no member for either of the units these kinds are billed
in, so it gains two:

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
  | 'GB-Hours' // Fargate memory
  | 'GB-Seconds'; // Lambda duration
```

The three kinds are typed in the schema with `params` in their own `$defs`, as
`050-edge-and-network-contracts.md` established. The parameters:

```typescript
// $defs: ecsClusterParams
export interface EcsClusterParams {
  containerInsights: boolean;
  capacityProviders: ('FARGATE' | 'FARGATE_SPOT')[];
}

// $defs: ecsServiceParams
export interface EcsServiceParams {
  launchType: 'FARGATE';
  /** Fargate CPU units. 1024 units is one vCPU. */
  cpuUnits: 256 | 512 | 1024 | 2048 | 4096 | 8192 | 16384;
  /** Must be a size Fargate allows for `cpuUnits`; enforced by the validator, not the schema. */
  memoryMb: number;
  desiredCount: number;
  containerPort: number;
  containerImage: string;
  /** Subnet node ids the tasks run in. At least one; two or more for a multi-AZ service. */
  subnetIds: string[];
  assignPublicIp: boolean;
  /** 20GB is included in the task price; only the excess is charged. */
  ephemeralStorageGb: number;
  capacityProvider: 'FARGATE' | 'FARGATE_SPOT';
  /** `alb` node id whose target group the tasks register with, or null for a worker. */
  loadBalancerNodeId: string | null;
  /** `iam_role` node ids. The execution role is required to pull an image and write logs. */
  executionRoleId: string;
  taskRoleId: string | null;
  logGroupId: string | null;
  autoScaling: {
    enabled: boolean;
    minCount: number;
    maxCount: number;
    targetCpuPercent: number;
  };
  deploymentCircuitBreaker: boolean;
  healthCheckGracePeriodSeconds: number;
}

// $defs: lambdaFunctionParams
export interface LambdaFunctionParams {
  runtime:
    | 'nodejs20.x'
    | 'nodejs22.x'
    | 'python3.12'
    | 'python3.13'
    | 'java21'
    | 'dotnet8'
    | 'provided.al2023';
  handler: string;
  architecture: 'arm64' | 'x86_64';
  /** 128 to 10240. CPU is proportional to memory, which is why it changes latency. */
  memoryMb: number;
  timeoutSeconds: number;
  packageType: 'Zip' | 'Image';
  invocationMode: 'sync' | 'async' | 'stream';
  /** Null means the function draws on the account's unreserved pool. */
  reservedConcurrency: number | null;
  provisionedConcurrency: number;
  /** Non-secret configuration only; `LAMBDA-SEC-001` fires on a key that looks like a secret. */
  environment: Record<string, string>;
  /** `iam_role` node id. Required: a function with no role cannot be created. */
  executionRoleId: string;
  /** Subnet node ids for a VPC-attached function. Empty means no VPC attachment. */
  subnetIds: string[];
  /** `sqs_queue` or `sns_topic` node id for failed asynchronous invocations. */
  deadLetterTargetId: string | null;
  logRetentionDays: number | null;
  tracingEnabled: boolean;
}
```

The Fargate CPU and memory combinations are a documented table rather than a free pair, so
`validateIr` gains one referential rule: `memoryMb` is one of the values Fargate allows for
`cpuUnits`, per
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-definition-parameters.html, read
2026-08-10. Expressing it in JSON Schema would need seven `if`/`then` branches whose failure message
points at the wrong property; a validator rule can name both properties in one problem.

Cost dimensions, with the offer code and the attribute filter `rateFor` matches on. Usage types are
copied verbatim from the offer file at implementation time and recorded in the fixture:

| Kind              | Offer       | Dimension               | Unit         | Attribute filter                            |
| ----------------- | ----------- | ----------------------- | ------------ | ------------------------------------------- |
| `ecs_service`     | `AmazonECS` | Fargate vCPU            | `vCPU-Hours` | `productFamily: Compute`, per-vCPU usage    |
| `ecs_service`     | `AmazonECS` | Fargate memory          | `GB-Hours`   | `productFamily: Compute`, per-GB usage      |
| `ecs_service`     | `AmazonECS` | Ephemeral storage       | `GB-Hours`   | ephemeral storage usage, excess over 20GB   |
| `lambda_function` | `AWSLambda` | Duration                | `GB-Seconds` | `productFamily: Serverless`, `architecture` |
| `lambda_function` | `AWSLambda` | Requests                | `Requests`   | `productFamily: Serverless`, request usage  |
| `lambda_function` | `AWSLambda` | Provisioned concurrency | `GB-Seconds` | provisioned concurrency usage               |
| `ecs_cluster`     | `AmazonECS` | none                    | n/a          | a Fargate-only cluster carries no charge    |

`capacityProvider: 'FARGATE_SPOT'` is reported in `unpriced` with the reason that
`docs/issues/epic-7-prediction/010-price-list-snapshot.md` deliberately discards Spot terms, rather
than being priced at the On-Demand rate. An architecture whose cost silently assumed On-Demand for a
Spot task would be wrong in the direction that looks safe and is not, because the user would then be
surprised by an interruption rather than by a bill.

`ecs_cluster` returns no cost components when `containerInsights` is false. When it is true, the
charge lands in the CloudWatch offer and depends on how many task-level metrics are published, which
the IR does not express, so it is reported in `unpriced` with that reason. A `priceSource` is still
returned, naming the snapshot and the ECS offer version, so the estimate can state which price list
the zero came from.

The quantity for each line, and the assumptions it comes from:

```
ecs_service vCPU-hours   = desiredCount * (cpuUnits / 1024) * time.hoursPerMonth
ecs_service GB-hours     = desiredCount * (memoryMb / 1024) * time.hoursPerMonth
lambda GB-seconds        = traffic.requestsPerMonth * (compute.lambdaDurationMs / 1000)
                           * (memoryMb / 1024)
lambda requests          = traffic.requestsPerMonth
lambda provisioned GB-s  = provisionedConcurrency * (memoryMb / 1024) * time.hoursPerMonth * 3600
```

The capacity models, written out so the latency model and the solver agree:

```
ecs_service   c            = autoScaling.enabled ? autoScaling.maxCount : desiredCount
              elastic      = autoScaling.enabled
              vcpu         = cpuUnits / 1024
              serviceTime  = DEFAULT_SERVICE_TIMES_MS.ecs * (0.5 / vcpu)
              limitIds     = ['fargate.onDemandVcpu', 'ecs.tasksPerService',
                              'alb.targetsPerTargetGroup', 'queue.capacity']

lambda        c            = reservedConcurrency ?? AWS_LIMITS['lambda.concurrentExecutions'].value
              elastic      = reservedConcurrency === null
              serviceTime  = compute.lambdaDurationMs * min(1, 1769 / memoryMb)
              limitIds     = ['lambda.concurrentExecutions', 'lambda.burstConcurrency',
                              'queue.capacity']

ecs_cluster   capacity()   = null
```

The `0.5 / vcpu` and `1769 / memoryMb` factors are stated because they are the whole content of the
model and would otherwise be invented twice. Lambda allocates one vCPU at 1,769MB
(https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-common.html, read 2026-08-10),
so duration falls roughly in proportion to memory up to that point and is flat beyond it for
single-threaded work; the ECS factor takes 0.5 vCPU as the reference size that
`DEFAULT_SERVICE_TIMES_MS.ecs` was chosen for. Both are linear speedup, which is optimistic and is
the only defensible default without a measurement -- the same argument `030-latency-model.md` makes
for setting both coefficients of variation to one. `compute.vcpuScalingExponent` exists as an
assumption defaulting to 1 so that anyone with a profile can replace it.

Cold start, for `lambda_function` only, from a runtime table with a citation and an editable share:

```typescript
export const COLD_START_MS: Record<LambdaFunctionParams['runtime'], number> = {
  'nodejs20.x': 250,
  'nodejs22.x': 250,
  'python3.12': 300,
  'python3.13': 300,
  java21: 1200,
  dotnet8: 900,
  'provided.al2023': 150,
};
```

A VPC-attached function adds `lambda.vpcColdStartMs`, defaulting to 100ms for the elastic network
interface attachment. `shareOfRequests` is `lambda.coldStartShare`, default 0.01, and is forced to
zero when `provisionedConcurrency >= reservedConcurrency`, with the basis string saying so. Every
figure here is a default assumption, not a constant: the point of the table is that a Java function
and a Node function do not get the same answer.

The limit table entries this issue adds to `packages/core/src/prediction/limits/aws-limits.ts`, each
with its value re-read at implementation time and the Service Quotas code copied from the console
page rather than guessed:

| Limit id                      | Value | Unit       | Adjustable | Source                                                                          |
| ----------------------------- | ----- | ---------- | ---------- | ------------------------------------------------------------------------------- |
| `fargate.onDemandVcpu`        | 6     | vCPU       | yes        | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-quotas.html |
| `ecs.tasksPerService`         | 5000  | tasks      | yes        | https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-quotas.html |
| `lambda.concurrentExecutions` | 1000  | executions | yes        | https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html         |
| `lambda.burstConcurrency`     | 1000  | executions | no         | https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html            |

`lambda.concurrentExecutions` already appears in `040-bottleneck-solver.md` with quota code
`L-B99A9384` and is referenced, not redefined. `fargate.onDemandVcpu` is the one that surprises
people: a default of 6 vCPUs per region is two 1-vCPU tasks and a deployment, so an architecture with
four services is quota-bound before it is capacity-bound, and the remedy is a quota increase rather
than a redesign.

Reliability:

| Kind              | Configuration | Availability | Basis     | Source                              |
| ----------------- | ------------- | ------------ | --------- | ----------------------------------- |
| `ecs_service`     | `multi-az`    | 0.9999       | published | https://aws.amazon.com/compute/sla/ |
| `ecs_service`     | `single-az`   | 0.995        | published | instance-level commitment, same SLA |
| `lambda_function` | `regional`    | 0.9995       | published | https://aws.amazon.com/lambda/sla/  |
| `ecs_cluster`     | `regional`    | 0.9999       | published | https://aws.amazon.com/compute/sla/ |

An `ecs_service` is `multi-az` when `subnetIds` resolves to two or more distinct availability zones
**and** `desiredCount` is at least two; one task in two subnets is still one task, and reporting it
as multi-AZ is the mistake the availability model exists to prevent. `singlePointOfFailure` is true
for a service with `desiredCount: 1` and for a function with `reservedConcurrency: 1`. The
`ecs_cluster` reports `singlePointOfFailure: false` with a basis noting that running tasks survive a
control-plane impairment, so the cluster is not on the request path even though every service depends
on it for deployment.

The Well-Architected rules:

- `ECS-REL-001` (reliability, high): `desiredCount` is 1, or `subnetIds` resolves to one
  availability zone. Pointer `/params/desiredCount`.
- `ECS-REL-002` (reliability, medium): `deploymentCircuitBreaker` is false, so a failing deployment
  replaces healthy tasks with unhealthy ones. Pointer `/params/deploymentCircuitBreaker`.
- `ECS-SEC-001` (security, high): `assignPublicIp` is true, or the nearest `subnet` ancestor has
  `tier: 'public'`. Pointer `/params/assignPublicIp`.
- `ECS-OPS-001` (operational-excellence, medium): `logGroupId` is null. Pointer `/params/logGroupId`.
- `ECS-PERF-001` (performance-efficiency, medium): `autoScaling.enabled` is false, so the service
  cannot answer a change in load. Pointer `/params/autoScaling/enabled`.
- `ECS-COST-001` (cost-optimisation, low): `desiredCount` is 1 and `cpuUnits` is 2048 or more, which
  costs the same as two smaller tasks and gives no redundancy. Pointer `/params/cpuUnits`.
- `ECSC-OPS-001` (operational-excellence, low): `containerInsights` is false on the cluster. Pointer
  `/params/containerInsights`.
- `LAMBDA-SEC-001` (security, high): an `environment` key matching `/SECRET|PASSWORD|TOKEN|_KEY$/i`,
  because a Lambda environment variable is readable by anyone with `lambda:GetFunction`. Pointer
  `/params/environment/<key>`.
- `LAMBDA-REL-001` (reliability, medium): `invocationMode` is `async` and `deadLetterTargetId` is
  null, so a failed event is discarded after its retries. Pointer `/params/deadLetterTargetId`.
- `LAMBDA-PERF-001` (performance-efficiency, medium): `timeoutSeconds` exceeds the
  `idleTimeoutSeconds` of an `alb` in `context.sources`, so the function keeps running and billing
  after the load balancer has already returned 504. Pointer `/params/timeoutSeconds`.
- `LAMBDA-COST-001` (cost-optimisation, low): `architecture` is `x86_64` on a runtime that supports
  `arm64`, which is a cheaper GB-second for the same work. Pointer `/params/architecture`.
- `LAMBDA-OPS-001` (operational-excellence, medium): `logRetentionDays` is null, so logs are kept and
  charged forever. Pointer `/params/logRetentionDays`.

Declared assumptions:

```typescript
// ecs_service
{ id: 'compute.vcpuScalingExponent', unit: 'exponent', defaultValue: 1, min: 0, max: 1 }
// lambda_function
{ id: 'compute.lambdaDurationMs', unit: 'ms', defaultValue: 120, min: 1, max: 900000 }
{ id: 'lambda.coldStartShare', unit: 'fraction', defaultValue: 0.01, min: 0, max: 1 }
{ id: 'lambda.vpcColdStartMs', unit: 'ms', defaultValue: 100, min: 0, max: null }
```

`time.hoursPerMonth` and `traffic.requestsPerMonth` are referenced from
`docs/issues/epic-7-prediction/020-cost-model.md` by id.

`emitPulumi` per kind: `aws.ecs.Cluster` for the cluster; `aws.ecs.TaskDefinition` plus
`aws.ecs.Service` for the service, referencing the cluster with `refFor(clusterId)` and the load
balancer's target group with `refFor(loadBalancerNodeId, 'targetGroup')` from
`050-edge-and-network-contracts.md`, and declaring `taskDefinition` in `secondaryRefs`;
`aws.lambda.Function` plus `aws.lambda.ProvisionedConcurrencyConfig` when
`provisionedConcurrency > 0`.

**No contract in this issue emits an IAM role or policy.** Both kinds reference their roles by node
id through `refFor(executionRoleId)`, which throws when the document has no such node, and the
`iam_role` contract that declares those variables is a separate issue. That boundary is deliberate:
one owner for IAM means one place to review, and a compute contract that synthesised a role would
have to guess the policy from the edges. The consequence is stated rather than hidden -- a project
assembled before the `iam_role` contract lands has an unresolved reference, which is why the golden
files in this issue are per-fragment and the project assembler belongs to the codegen epic (#9).

### Files

- MODIFY `packages/core/src/resources/contract.ts` - `CapacityModel`, the `coldStart` member, the
  `latency(params, usage)` signature and the `capacity` member
- MODIFY `packages/core/src/resources/registry.ts` - reject a contract whose `capacity` returns a
  `CapacityModel` naming a limit id absent from `AWS_LIMITS`
- MODIFY `packages/core/src/resources/rds-instance/latency.ts` - satisfy the new `latency` signature
  and return a `CapacityModel` naming `rds.maxConnections`. Do not change its figures
- MODIFY `packages/core/src/pricing/snapshot.ts` - add `GB-Hours` and `GB-Seconds` to `PriceUnit`
- MODIFY `scripts/ci/build-price-snapshot.mjs` - keep the Fargate and Lambda usage types and the
  `architecture` attribute in the whitelist
- MODIFY `packages/core/src/prediction/limits/aws-limits.ts` - add `fargate.onDemandVcpu`,
  `ecs.tasksPerService` and `lambda.burstConcurrency`
- CREATE `packages/core/src/resources/ecs-cluster/index.ts`
- CREATE `packages/core/src/resources/ecs-cluster/cost.ts`
- CREATE `packages/core/src/resources/ecs-cluster/reliability.ts`
- CREATE `packages/core/src/resources/ecs-cluster/rules.ts`
- CREATE `packages/core/src/resources/ecs-cluster/emit.ts`
- CREATE `packages/core/src/resources/ecs-cluster/ecs-cluster.test.ts`
- CREATE `packages/core/src/resources/ecs-cluster/__golden__/compute.cluster.ts`
- CREATE `packages/core/src/resources/ecs-service/index.ts`
- CREATE `packages/core/src/resources/ecs-service/cost.ts`
- CREATE `packages/core/src/resources/ecs-service/capacity.ts`
- CREATE `packages/core/src/resources/ecs-service/latency.ts`
- CREATE `packages/core/src/resources/ecs-service/reliability.ts`
- CREATE `packages/core/src/resources/ecs-service/rules.ts`
- CREATE `packages/core/src/resources/ecs-service/emit.ts`
- CREATE `packages/core/src/resources/ecs-service/ecs-service.test.ts`
- CREATE `packages/core/src/resources/ecs-service/__golden__/compute.service.ts`
- CREATE `packages/core/src/resources/lambda-function/index.ts`
- CREATE `packages/core/src/resources/lambda-function/cost.ts`
- CREATE `packages/core/src/resources/lambda-function/capacity.ts`
- CREATE `packages/core/src/resources/lambda-function/latency.ts`
- CREATE `packages/core/src/resources/lambda-function/cold-start.ts`
- CREATE `packages/core/src/resources/lambda-function/reliability.ts`
- CREATE `packages/core/src/resources/lambda-function/rules.ts`
- CREATE `packages/core/src/resources/lambda-function/emit.ts`
- CREATE `packages/core/src/resources/lambda-function/lambda-function.test.ts`
- CREATE `packages/core/src/resources/lambda-function/__golden__/compute.lambda.ts`
- CREATE `packages/core/src/resources/__fixtures__/price-snapshot.compute.json` - the rates these
  tests price against, each with its SKU, offer version and publication date
- CREATE `packages/ir-schema/fixtures/compute-fargate-lambda.json`
- MODIFY `packages/ir-schema/schema/architecture-ir.schema.json` - type `ecs_cluster`,
  `ecs_service` and `lambda_function`, add their `params` `$defs`, drop them from
  `pendingContractNode`
- MODIFY `packages/ir-schema/src/validate.ts` - the Fargate CPU and memory pairing rule
- MODIFY `packages/ir-schema/VERSION` - minor bump
- MODIFY `packages/ir-schema/src/generated/types.ts` - regenerated
- MODIFY `services/brain/src/brain/ir/models.py` - regenerated
- MODIFY `packages/core/src/index.ts` - export the three contracts and `CapacityModel`
- MODIFY `packages/core/src/resources/README.md` - how a capacity model is written

### Acceptance Criteria

- [ ] A two-task Fargate service reports separate vCPU-hour and GB-hour components whose totals sum to the monthly figure
- [ ] A Lambda function reports separate duration and request components, and a provisioned concurrency component only when `provisionedConcurrency` is above zero
- [ ] `capacityProvider: 'FARGATE_SPOT'` produces an `unpriced` entry naming Spot rather than an On-Demand price
- [ ] `ecs_cluster` with Container Insights enabled reports it in `unpriced` with a reason, and still returns a `priceSource`
- [ ] `capacity` for an ECS service returns `servers` equal to `desiredCount`, or to `autoScaling.maxCount` with `elastic: true` when autoscaling is on
- [ ] `capacity` for a Lambda function returns `servers` equal to `reservedConcurrency`, and falls back to the regional concurrency limit with `elastic: true` when it is null
- [ ] Doubling `cpuUnits` halves the reported `serviceTimeMs`, and doubling `memoryMb` below 1769 halves the Lambda service time
- [ ] Raising `memoryMb` above 1769 does not reduce the Lambda service time further
- [ ] Every `CapacityModel` names only limit ids present in `AWS_LIMITS`, asserted for every registered contract
- [ ] `capacity` returns null for `ecs_cluster`
- [ ] `coldStart` is present for a Lambda function, carries the runtime figure, and reports `shareOfRequests: 0` when provisioned concurrency covers the reserved concurrency
- [ ] A Java runtime reports a higher cold start than a Node runtime
- [ ] A one-task service in two subnets reports `single-az` rather than `multi-az`
- [ ] `LAMBDA-SEC-001` fires on an environment key named `DB_PASSWORD` and not on one named `LOG_LEVEL`
- [ ] `LAMBDA-PERF-001` fires only when an `alb` in `context.sources` has a shorter idle timeout, and returns null when `context.sources` is empty
- [ ] Every rule returns null rather than throwing when the parameter it reads is absent
- [ ] `emitPulumi` output matches each `__golden__` file byte for byte
- [ ] `emitPulumi` for an ECS service throws when `executionRoleId` names a node the document does not contain
- [ ] `validateIr` rejects a Fargate task with `cpuUnits: 256` and `memoryMb: 4096`, naming both properties

### Required Tests

- `prices a fargate service from vcpu hours and gb hours`
- `prices a lambda function from gb seconds and requests`
- `matches the published price scenario for a fargate service` - two tasks at 0.5 vCPU and 1GB for
  730 hours is 36.04 USD at the fixture rate, asserted to the cent
- `matches the published price scenario for a lambda function` - one million requests at 512MB and
  200ms is 1.87 USD at the fixture rate, asserted to the cent
- `reports fargate spot as unpriced rather than charging the on demand rate`
- `reports container insights as unpriced with a reason`
- `derives servers from the desired count and from autoscaling`
- `derives lambda servers from reserved concurrency and falls back to the regional limit`
- `scales service time with vcpu and with memory up to one vcpu`
- `stops scaling lambda service time above 1769 megabytes`
- `reports a cold start for every runtime and none under provisioned concurrency`
- `names only limit ids that exist in the limit table`
- `returns a null capacity model for the cluster`
- `treats a single task in two subnets as single az`
- `flags a plaintext secret in the function environment`
- `flags a timeout longer than the load balancer idle timeout and passes with no load balancer`
- `returns null from every rule when the parameter it reads is absent`
- `emits pulumi matching the golden files`
- `throws when the execution role node is missing from the document`
- `rejects an invalid fargate cpu and memory pairing`

### Performance Budget

Cost, latency, capacity, reliability and every rule for a 200-node document complete in under 50ms,
measured with `performance.now()` in `ecs-service.test.ts`, holding the budget
`040-resource-contract-registry.md` set. `capacity` performs no snapshot lookup, so a solver that
calls it once per bisection step -- up to forty per limit -- stays inside the solver's own 15ms budget.

### Out of Scope

- Do not implement the `iam_role` contract, or emit any role, policy or trust document
- Do not implement `ec2_instance`, even though `proposeArchitecture` still proposes `ec2` for an
  unpackaged component. Its cost has a different shape, with EBS volumes and instance families, and
  bolting it on here doubles the issue
- Do not implement `app_runner`, `batch` or `eks_cluster`; they are in the catalogue and are not IR
  kinds
- Do not solve for a breaking request rate. This issue supplies `capacity` and the limit entries;
  `docs/issues/epic-7-prediction/040-bottleneck-solver.md` (#8) does the solving
- Do not model autoscaling policy dynamics, warm pools, or scheduled scaling. `elastic` and
  `maxCount` are what the solver gets
- Do not add Savings Plans or Compute Savings Plan pricing for Fargate
- Do not change `packages/core/src/analysis/architecture.ts` to propose `fargate` instead of `ecs`
- Do not touch `packages/core/src/codegen/pulumi.ts` or `terraform.ts`, which still carry a `lambda`
  case in a `switch`. Replacing them is the codegen epic (#9)

### Dependencies

Blocked by `docs/issues/epic-2-ir/040-resource-contract-registry.md` and by
`docs/issues/epic-2-ir/050-edge-and-network-contracts.md`, which widens the contract module and
declares the ALB target group this issue attaches to. Blocked by
`docs/issues/epic-7-prediction/010-price-list-snapshot.md` (#8) for the snapshot, whose `PriceUnit`
union and usage-type whitelist this issue extends. Consumed by
`docs/issues/epic-7-prediction/030-latency-model.md` and
`docs/issues/epic-7-prediction/040-bottleneck-solver.md` (#8).

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
