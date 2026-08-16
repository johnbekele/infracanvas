---
title: '[ir] Resource contracts for SageMaker endpoints and Bedrock models'
labels: tier:1, size:l, area:ir, epic:2-ir
---

### Epic

#3

### Context

This is the group the product's target user cares about most and the one the IR cannot currently
describe at all. `packages/core/src/analysis/architecture.ts` already proposes both kinds -- a
`sagemaker-endpoint` node for a component that runs inference and serves no request path, and a
`bedrock` node whenever the repository calls a model API -- but neither `sagemaker_endpoint` nor
`bedrock_model` appears in the `resourceKind` enum in
`packages/ir-schema/schema/architecture-ir.schema.json`. Every other kind in this epic was pending a
contract; these two are pending existence. Adding them to the enum, with typed parameters and a
contract each, is the first extension in this epic that widens what the IR can say rather than
tightening what it already says, and it is called out here because a reviewer should see it as a schema
decision and not as a mechanical addition.

The two are priced in completely different currencies, and that contrast is the point of grouping
them. A real-time SageMaker endpoint on one `ml.g5.xlarge` costs the same every month whether it
serves one request or a million, because an endpoint is rented instance hours; at 730 hours that is
over a thousand dollars, which is more than the rest of a small architecture put together. Bedrock
on-demand costs nothing at zero traffic and, at a hundred thousand requests with a 1,200-token prompt
and a 400-token answer, lands in the same order of magnitude. The two figures are close and the two
cost curves are nothing alike, so a user choosing between them needs to see which assumptions each
number rests on, not just the totals. An estimate that reports a single Bedrock figure without
showing tokens per request and requests per month is not an estimate; it is a number with a currency
symbol in front of it. So every Bedrock cost component must name the assumptions its quantity came
from, and a test asserts that none of them is a fixed rate.

**Latency has to be reported differently for a streamed answer, and the interface cannot do it.**
`LatencyContribution` carries a p50 and a p95 for a request that traverses the resource once, which is
the right shape for a database query and the wrong shape for a model that streams. The latency a user
experiences is time to first token; the latency the resource occupies is the whole completion, which
for 400 output tokens is an order of magnitude longer. Reporting only the completion time makes the
product look slow and drives the SLO derivation in
`docs/issues/epic-7-prediction/050-availability-and-slo.md` to commit to a target that describes
nothing a user waits for. So `LatencyContribution` gains an optional `streaming` member with the
time-to-first-token percentiles and a per-output-token rate, and the full-completion figures stay in
`p50Ms` and `p95Ms` because that is what the queueing model needs for residence time. Cold start is
reused from `docs/issues/epic-2-ir/060-compute-contracts.md` rather than reinvented: a serverless
SageMaker endpoint pays a model-load cost on a cold invocation exactly the way a Lambda function pays
an initialisation cost, and provisioned throughput on Bedrock removes the token-rate quota that
otherwise makes p95 depend on how much someone else is using the model.

**The default latency figures here have no citation, and the spec says so.** AWS publishes no
time-to-first-token or tokens-per-second figure for any Bedrock model, and the numbers vary with
prompt length, model and region. Inventing a citation would be worse than admitting there is none, so
`llm.timeToFirstTokenMs` and `llm.msPerOutputToken` are declared assumptions with order-of-magnitude
defaults, a rationale that states plainly they are not published, and the recommendation that they are
the first two values a user replaces with a measurement. The rejected alternative was to omit model
latency altogether until Epic #11 measures it, which would leave the one component whose latency
dominates the request path contributing zero.

**This issue emits IAM, deliberately, and is tier 1 because of it.** For on-demand Bedrock there is no
resource to create: the entire artefact is a permission to invoke a model. A contract that emitted
nothing would leave an architecture that cannot call the model it was drawn with, and the permission
would be hand-written later as `bedrock:InvokeModel` on `*`, which is the outcome this whole registry
exists to prevent. So the Bedrock contract emits an `aws.iam.RolePolicy` on the referenced caller role,
scoped to the one model ARN. That is a deliberate exception to the boundary
`060-compute-contracts.md` sets, where compute contracts reference their execution roles and emit no
policy: a role's own permissions -- log writing, VPC attachment -- are the role's business, but which
models a caller may invoke is knowledge only the Bedrock node has.

Spec: `docs/issues/epic-2-ir/040-resource-contract-registry.md`

### Contract

The schema change, which is the part to review first. `resourceKind` gains two members and two typed
branches; neither is ever added to `pendingContractNode`, because both arrive with a contract:

```json
{
  "$defs": {
    "resourceKind": {
      "enum": ["vpc", "subnet", "...", "sagemaker_endpoint", "bedrock_model"]
    },
    "sagemakerEndpointNode": {
      "allOf": [{ "$ref": "#/$defs/nodeBase" }],
      "unevaluatedProperties": false,
      "properties": {
        "kind": { "const": "sagemaker_endpoint" },
        "params": { "$ref": "#/$defs/sagemakerEndpointParams" }
      }
    }
  }
}
```

The additive change to the shared contract module, on top of `050`, `060` and `070`:

```typescript
// packages/core/src/resources/contract.ts
export interface LatencyContribution {
  /** Whole-response latency. This is what the queueing model uses as residence time. */
  p50Ms: number;
  p95Ms: number;
  basis: string;
  coldStart?: {
    p50Ms: number;
    p95Ms: number;
    shareOfRequests: number;
    assumptionIds: string[];
  };
  /** Present for a resource that streams a response, where first byte is what a user waits for. */
  streaming?: {
    timeToFirstTokenP50Ms: number;
    timeToFirstTokenP95Ms: number;
    msPerOutputToken: number;
    assumptionIds: string[];
  };
}
```

`PriceUnit` gains the two units these kinds are billed in:

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
  | 'ReadRequestUnits'
  | 'WriteRequestUnits'
  | 'ReadCapacityUnit-Hrs'
  | 'WriteCapacityUnit-Hrs'
  | '1K-Tokens' // Bedrock on-demand and batch inference
  | 'Model-Unit-Hrs'; // Bedrock provisioned throughput
```

The parameters, each `$defs` entry declaring `additionalProperties: false`:

```typescript
// $defs: sagemakerEndpointParams
export interface SagemakerEndpointParams {
  endpointMode: 'realtime' | 'serverless' | 'async';
  /** An `ml.` instance type. Required for realtime and async, null for serverless. */
  instanceType: string | null;
  instanceCount: number;
  /** ECR image URI for the inference container. */
  modelImage: string;
  /** S3 URI of the model artefact, or null for a container that bundles its weights. */
  modelDataUrl: string | null;
  /** `iam_role` node id. Required: an endpoint cannot be created without an execution role. */
  executionRoleId: string;
  enableNetworkIsolation: boolean;
  autoScaling: { enabled: boolean; minInstanceCount: number; maxInstanceCount: number };
  dataCapture: {
    enabled: boolean;
    /** `s3_bucket` node id captured payloads are written to. */
    bucketId: string | null;
    samplingPercent: number;
  };
  /** Serverless only, and rejected in the other modes by the validator. */
  serverlessMaxConcurrency: number | null;
  serverlessMemoryMb: number | null;
}

// $defs: bedrockModelParams
export interface BedrockModelParams {
  /** A Bedrock model id, for example `anthropic.claude-sonnet-4-20250514-v1:0`. */
  modelId: string;
  invocationMode: 'on-demand' | 'provisioned' | 'batch';
  /** Provisioned only. Must be zero in the other modes, enforced by the validator. */
  modelUnits: number;
  maxOutputTokens: number;
  streaming: boolean;
  /** Guardrail identifier, or null when no guardrail is attached. */
  guardrailId: string | null;
  invocationLogging: boolean;
  /** `iam_role` node id the invoke permission is attached to. Required. */
  callerRoleId: string;
}
```

`modelId` is an open string in the schema with a `pattern` rather than an enum, because the catalogue's
seven options in `packages/core/src/services/ai.ts` are a menu and not the set of models that exist. A
model id with no rate in the snapshot is reported in `unpriced` naming the model, which is the correct
answer for a model AWS has released since the snapshot was built.

Cost dimensions, with the offer code and the attribute filter. Usage types and the exact attribute
names for the Bedrock offer are copied verbatim from the offer file at implementation time and recorded
in the fixture; a contract must not pattern-match on a guessed usage type, and the Bedrock offer's
attribute naming is the least stable in this epic:

| Kind                 | Offer             | Dimension                | Unit             | Attribute filter                                            |
| -------------------- | ----------------- | ------------------------ | ---------------- | ----------------------------------------------------------- |
| `sagemaker_endpoint` | `AmazonSageMaker` | Real-time instance hours | `Hrs`            | `productFamily: ML Instance`, `instanceType`, hosting usage |
| `sagemaker_endpoint` | `AmazonSageMaker` | Serverless duration      | `GB-Seconds`     | serverless inference usage                                  |
| `bedrock_model`      | `AmazonBedrock`   | Input tokens             | `1K-Tokens`      | `model`, `inferenceType: On-demand`, input direction        |
| `bedrock_model`      | `AmazonBedrock`   | Output tokens            | `1K-Tokens`      | `model`, `inferenceType: On-demand`, output direction       |
| `bedrock_model`      | `AmazonBedrock`   | Batch tokens             | `1K-Tokens`      | `model`, `inferenceType: Batch`                             |
| `bedrock_model`      | `AmazonBedrock`   | Provisioned throughput   | `Model-Unit-Hrs` | `model`, `inferenceType: Provisioned`, no commitment        |

Batch inference is priced by reading the batch rate from the snapshot, not by applying a discount to
the on-demand rate. The two happen to be related today, and a model whose batch rate AWS sets
differently would otherwise be priced from arithmetic nobody checks.

The quantities, and the assumptions they come from:

```
invocations         = traffic.requestsPerMonth * llm.invocationsPerRequest
input 1K-tokens     = invocations * llm.inputTokensPerRequest  / 1000
output 1K-tokens    = invocations * llm.outputTokensPerRequest / 1000
provisioned MU-hrs  = modelUnits * time.hoursPerMonth

sagemaker realtime  = instanceCount * time.hoursPerMonth       instance hours, traffic independent
sagemaker serverless = invocations * (sagemaker.inferenceMs / 1000)
                       * (serverlessMemoryMb / 1024)
```

The traffic independence of the real-time line is stated in that component's `basis` in as many
words, because it is the single most useful thing the estimate can tell a user about an endpoint: the
cost does not fall when the traffic does, and an endpoint at low utilisation is the most expensive way
to serve a model. `endpointMode: 'async'` is priced as instance hours while the endpoint has instances
and reported in `unpriced` for the scaled-to-zero periods, because the IR does not express a schedule.

Latency, and the parts of it that change the answer:

- `sagemaker_endpoint`, realtime: `p50Ms` and `p95Ms` from `sagemaker.inferenceMs`, defaulting to
  120ms, with `capacity` returning `servers = instanceCount * sagemaker.concurrencyPerInstance` and
  `limitIds` `['sagemaker.endpointInstanceCount.<instanceType>', 'queue.capacity']`. No cold start:
  the endpoint is
  always warm, which is what the money buys.
- `sagemaker_endpoint`, serverless: the same service time plus a `coldStart` whose figure is
  `sagemaker.modelLoadMs`, defaulting to 4,000ms because a container that has to pull an image and
  load weights is nothing like a Lambda zip, with `shareOfRequests` from `sagemaker.coldStartShare`.
- `bedrock_model`: `p50Ms` is the first-token time plus the output tokens times the per-token rate,
  which for the defaults is 450 + 400 x 25 = 10,450ms, and `streaming`
  reports the 450ms first-token figure separately. `capacity` returns null for on-demand -- there is
  no server count a user controls -- with `limitIds` naming the per-model request and token rate
  quotas so the solver can still find the throttling point. Provisioned throughput returns
  `servers = modelUnits`, `elastic: false`, and no token-rate quota, because that is what a model unit
  buys.

A completion latency above ten seconds is not a defect in the model; it is the honest answer for 400
streamed tokens, and it is why `streaming` exists. The SLO derivation must be able to propose a
latency objective against first token rather than against the whole completion.

Reliability:

| Kind                 | Configuration     | Availability | Basis     | Source                                |
| -------------------- | ----------------- | ------------ | --------- | ------------------------------------- |
| `sagemaker_endpoint` | `multi-instance`  | 0.9995       | published | https://aws.amazon.com/sagemaker/sla/ |
| `sagemaker_endpoint` | `single-instance` | 0.99         | modelled  | one instance, no commitment covers it |
| `bedrock_model`      | `regional`        | 0.999        | published | https://aws.amazon.com/bedrock/sla/   |

`bedrock_model` reports `azCount: 0`, the value
`docs/issues/epic-2-ir/050-edge-and-network-contracts.md` defines for a resource whose placement the
IR does not express, so the availability model treats it as a series component with its published
figure and never as a parallel group. A single-instance endpoint reports
`singlePointOfFailure: true`. Neither kind reports `durabilityNines`; the concept does not apply.
Every SLA figure is re-read from the cited page at implementation time and `retrievedAt` set to that
day.

Service quotas, added to `packages/core/src/prediction/limits/aws-limits.ts`. Both are per-model or
per-instance-type figures, and `ServiceLimit.value` is a scalar, so one entry is registered per
identifier from a table in the contract directory rather than changing that interface:

| Limit id                                         | Unit         | Adjustable | Source                                                              |
| ------------------------------------------------ | ------------ | ---------- | ------------------------------------------------------------------- |
| `bedrock.requestsPerMinute.<modelId>`            | requests/min | yes        | https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html    |
| `bedrock.tokensPerMinute.<modelId>`              | tokens/min   | yes        | https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html    |
| `sagemaker.endpointInstanceCount.<instanceType>` | instances    | yes        | https://docs.aws.amazon.com/sagemaker/latest/dg/regions-quotas.html |

The SageMaker one is the entry that earns its place. The default account quota for accelerated
instance types for endpoint usage is frequently zero, so a proposed `ml.g5.xlarge` endpoint cannot be
created at all until a quota increase is granted. A bottleneck report that says "this cannot be
deployed in a fresh account, request quota X" is more useful than any request rate, and a limit of
zero must therefore be a first-class value in the table rather than being read as "unknown". A model
id or instance type with no recorded quota is reported as a gap in the `Prediction`, never as
unlimited.

The Well-Architected rules:

- `SM-COST-001` (cost-optimisation, high): `endpointMode: 'realtime'` while the assumed traffic
  leaves utilisation below `sagemaker.minUtilisation`, so the endpoint is paying for idle accelerator
  hours. The finding quotes the monthly figure and the per-request figure, because the per-request
  figure is what makes it obvious. Pointer `/params/endpointMode`.
- `SM-REL-001` (reliability, high): `instanceCount` is 1. Pointer `/params/instanceCount`.
- `SM-SEC-001` (security, medium): `dataCapture.enabled` is true and the bucket it resolves to in
  `context.targets` has `blockPublicAccess: false` or `encryption` unset, because captured payloads
  are the raw inputs users sent. Pointer `/params/dataCapture/bucketId`.
- `SM-SEC-002` (security, medium): `enableNetworkIsolation` is false, so the inference container has
  outbound internet access. Pointer `/params/enableNetworkIsolation`.
- `SM-PERF-001` (performance-efficiency, medium): `autoScaling.enabled` is false, or
  `maxInstanceCount` equals `instanceCount`. Pointer `/params/autoScaling/enabled`.
- `SM-OPS-001` (operational-excellence, low): `dataCapture.enabled` is false, so there is no record
  to detect model drift against. It does not contradict `SM-SEC-001`: capture is worth having, and
  worth encrypting. Pointer `/params/dataCapture/enabled`.
- `BR-SEC-001` (security, medium): `guardrailId` is null, so nothing filters model input or output.
  Pointer `/params/guardrailId`.
- `BR-OPS-001` (operational-excellence, medium): `invocationLogging` is false, so there is no record
  of prompts and completions to investigate an abuse report or a bad answer with. Pointer
  `/params/invocationLogging`.
- `BR-COST-001` (cost-optimisation, high): the mode costs more than the alternative at the assumed
  traffic -- on-demand above the provisioned crossover, or provisioned below it -- with both monthly
  figures quoted in the message. Pointer `/params/invocationMode`.
- `BR-REL-001` (reliability, medium): `invocationMode: 'on-demand'` and the assumed token rate exceeds
  the model's recorded tokens-per-minute quota, so invocations are throttled at the assumed traffic.
  Pointer `/params/invocationMode`.
- `BR-PERF-001` (performance-efficiency, medium): `streaming` is false with
  `llm.outputTokensPerRequest` above 200, so a user waits for the whole completion when they could be
  reading it. Pointer `/params/streaming`.
- `BR-SEC-002` (security, high): the emitted invoke policy would not be scoped to a single model,
  which can only happen if `modelId` is empty or a wildcard. Pointer `/params/modelId`.

Declared assumptions, every one of them editable, and the reason this issue exists:

```typescript
// bedrock_model
{ id: 'llm.invocationsPerRequest', unit: 'invocations', defaultValue: 1, min: 0, max: null }
{ id: 'llm.inputTokensPerRequest', unit: 'tokens', defaultValue: 1200, min: 0, exclusiveMin: true }
{ id: 'llm.outputTokensPerRequest', unit: 'tokens', defaultValue: 400, min: 0, exclusiveMin: true }
{ id: 'llm.timeToFirstTokenMs', unit: 'ms', defaultValue: 450, min: 0, exclusiveMin: true }
{ id: 'llm.msPerOutputToken', unit: 'ms', defaultValue: 25, min: 0, exclusiveMin: true }
// sagemaker_endpoint
{ id: 'sagemaker.inferenceMs', unit: 'ms', defaultValue: 120, min: 0, exclusiveMin: true }
{ id: 'sagemaker.concurrencyPerInstance', unit: 'requests', defaultValue: 4, min: 1, max: null }
{ id: 'sagemaker.modelLoadMs', unit: 'ms', defaultValue: 4000, min: 0, max: null }
{ id: 'sagemaker.coldStartShare', unit: 'fraction', defaultValue: 0.05, min: 0, max: 1 }
{ id: 'sagemaker.minUtilisation', unit: 'fraction', defaultValue: 0.05, min: 0, max: 1 }
```

The rationale on `llm.timeToFirstTokenMs` and `llm.msPerOutputToken` states that AWS publishes no
figure for either, that the defaults are order-of-magnitude values for a mid-sized model, and that a
measurement should replace them. `traffic.requestsPerMonth` and `time.hoursPerMonth` are referenced
from `docs/issues/epic-7-prediction/020-cost-model.md` by id.

`emitPulumi` per kind:

- `sagemaker_endpoint`: `aws.sagemaker.Model`, `aws.sagemaker.EndpointConfiguration` and
  `aws.sagemaker.Endpoint`, with `model` and `endpointConfiguration` in `secondaryRefs`, referencing
  the execution role with `refFor(executionRoleId)` and emitting no role of its own.
- `bedrock_model`: `aws.bedrock.ProvisionedModelThroughput` when `invocationMode` is `provisioned`,
  and in every mode one `aws.iam.RolePolicy` attached to `refFor(callerRoleId)` allowing
  `bedrock:InvokeModel`, plus `bedrock:InvokeModelWithResponseStream` when `streaming` is true, on the
  single ARN `arn:aws:bedrock:<region>::foundation-model/<modelId>`. No wildcard appears in the
  emitted policy, and a golden test asserts it.

### Files

- MODIFY `packages/core/src/resources/contract.ts` - the `streaming` member on
  `LatencyContribution`
- MODIFY `packages/core/src/pricing/snapshot.ts` - `1K-Tokens` and `Model-Unit-Hrs` on `PriceUnit`
- MODIFY `scripts/ci/build-price-snapshot.mjs` - add the `AmazonBedrock` and `AmazonSageMaker` offers
  to the fetch list and `model` and `inferenceType` to the attribute whitelist, and re-check the
  2MB gzipped budget
- MODIFY `data/pricing/README.md` - record what the two new offers contribute and the spot checks
- MODIFY `packages/core/src/prediction/limits/aws-limits.ts` - the per-model and per-instance-type
  quota entries
- CREATE `packages/core/src/resources/sagemaker-endpoint/index.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/cost.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/capacity.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/latency.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/reliability.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/rules.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/emit.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/quotas.ts` - endpoint instance quotas per
  instance type, with source URLs and retrieval dates
- CREATE `packages/core/src/resources/sagemaker-endpoint/sagemaker-endpoint.test.ts`
- CREATE `packages/core/src/resources/sagemaker-endpoint/__golden__/ml.sagemaker.ts`
- CREATE `packages/core/src/resources/bedrock-model/index.ts`
- CREATE `packages/core/src/resources/bedrock-model/cost.ts`
- CREATE `packages/core/src/resources/bedrock-model/tokens.ts` - the token quantity model
- CREATE `packages/core/src/resources/bedrock-model/latency.ts`
- CREATE `packages/core/src/resources/bedrock-model/reliability.ts`
- CREATE `packages/core/src/resources/bedrock-model/rules.ts`
- CREATE `packages/core/src/resources/bedrock-model/emit.ts`
- CREATE `packages/core/src/resources/bedrock-model/quotas.ts` - per-model request and token rate
  quotas, with source URLs and retrieval dates
- CREATE `packages/core/src/resources/bedrock-model/bedrock-model.test.ts`
- CREATE `packages/core/src/resources/bedrock-model/__golden__/ml.bedrock.ts`
- CREATE `packages/core/src/resources/__fixtures__/price-snapshot.ml.json` - the rates these tests
  price against, each with its SKU, offer version and publication date
- CREATE `packages/ir-schema/fixtures/ml-inference.json`
- MODIFY `packages/ir-schema/schema/architecture-ir.schema.json` - add `sagemaker_endpoint` and
  `bedrock_model` to `resourceKind`, add their node branches and `params` `$defs`
- MODIFY `packages/ir-schema/src/validate.ts` - the mode-dependent parameter rules for both kinds
- MODIFY `packages/ir-schema/VERSION` - minor bump
- MODIFY `packages/ir-schema/src/generated/types.ts` - regenerated
- MODIFY `services/brain/src/brain/ir/models.py` - regenerated
- MODIFY `packages/core/src/ir/kind-map.ts` - map `sagemaker_endpoint` to `sagemaker-endpoint` and
  `bedrock_model` to `bedrock`
- MODIFY `packages/core/src/index.ts` - export the two contracts
- MODIFY `packages/core/src/resources/README.md` - the token assumption model and why it is visible

### Acceptance Criteria

- [ ] `resourceKind` contains `sagemaker_endpoint` and `bedrock_model`, and neither appears in `pendingContractNode`
- [ ] `kindsWithoutContract()` still returns exactly the schema's pending list after both kinds are added
- [ ] Every value in `resourceKind` appears in exactly one typed branch or the pending branch, asserted by the existing test rather than by review
- [ ] `kindToServiceId` resolves both new kinds, so `irToCanvas` renders them rather than refusing them
- [ ] A real-time endpoint reports an instance-hour component whose quantity does not change when the traffic assumptions change, and whose basis says so
- [ ] A Bedrock estimate reports separate input-token and output-token components, and no component has an empty `assumptionIds`
- [ ] Halving `llm.inputTokensPerRequest` halves the input-token component and leaves the output-token component unchanged
- [ ] Batch mode is priced from the batch rate in the snapshot, not from the on-demand rate times a factor
- [ ] A `modelId` with no rate in the snapshot is reported in `unpriced` naming the model, and contributes nothing to the total
- [ ] `latency` for a streaming Bedrock model reports a `streaming` first-token figure well below its `p50Ms`
- [ ] A serverless endpoint reports a `coldStart` and a real-time endpoint does not
- [ ] Provisioned Bedrock returns a `capacity` with `servers` equal to `modelUnits` and no token-rate quota in `limitIds`
- [ ] A single-instance endpoint reports `singlePointOfFailure: true`, and a two-instance endpoint reports `basis: 'published'`
- [ ] An instance type whose recorded endpoint quota is zero produces a bottleneck entry rather than being read as unlimited
- [ ] A model id with no recorded quota produces a gap rather than an unlimited rate
- [ ] `SM-COST-001` quotes both the monthly figure and the per-request figure
- [ ] `BR-COST-001` quotes both the on-demand and the provisioned monthly figures
- [ ] The emitted Bedrock policy names exactly one model ARN and contains no wildcard
- [ ] `emitPulumi` output matches each `__golden__` file byte for byte
- [ ] `emitPulumi` throws when `callerRoleId` or `executionRoleId` names a node the document does not contain
- [ ] Regenerating types after the schema change leaves the working tree clean, and `uv run --directory services/brain mypy` passes

### Required Tests

- `matches the published price scenario for a real time endpoint` - 730 hours of one
  `ml.g5.xlarge` at the fixture rate of 1.408 USD per hour is 1027.84 USD, asserted to the cent
  against the fixture and traceable to the SKU recorded in it
- `matches the published price scenario for a bedrock model` - one hundred thousand invocations at
  1,200 input and 400 output tokens on Claude Sonnet 4 is 960.00 USD at the fixture input rate of
  0.003 USD and output rate of 0.015 USD per thousand tokens, asserted to the cent
- `keeps the endpoint cost unchanged when the traffic assumptions change`
- `names an assumption on every bedrock cost component`
- `halves the input token cost when the input token assumption halves`
- `prices batch mode from the batch rate rather than a discount`
- `reports an unknown model id as unpriced rather than pricing it as another model`
- `reports first token latency separately from the completion latency`
- `reports a cold start for a serverless endpoint and none for a real time endpoint`
- `returns model units as the server count under provisioned throughput`
- `treats a single instance endpoint as a single point of failure`
- `treats a zero endpoint instance quota as a bottleneck rather than as unlimited`
- `reports a gap for a model with no recorded token rate quota`
- `flags an idle real time endpoint with both the monthly and the per request figure`
- `flags the more expensive invocation mode with both figures quoted`
- `emits an invoke policy scoped to one model arn with no wildcard`
- `returns null from every rule when the parameter it reads is absent`
- `emits pulumi matching the golden files`
- `throws when the caller role node is missing from the document`
- `reports every resource kind as either contracted or pending exactly once`

### Performance Budget

Cost, latency, capacity, reliability and every rule for a 200-node document complete in under 50ms,
measured with `performance.now()` in `bedrock-model.test.ts`, holding the budget
`040-resource-contract-registry.md` set. The two new offers must keep
`data/pricing/aws-prices.v1.json.gz` under the 2MB gzipped limit
`docs/issues/epic-7-prediction/010-price-list-snapshot.md` enforces; the Bedrock offer is small, and
the SageMaker offer is restricted to hosting usage types for the four supported regions to stay
inside it.

### Out of Scope

- Do not implement `bedrock-knowledge-base`, `bedrock-agent`, `bedrock-guardrail`,
  `sagemaker-training`, `opensearch-vector` or any other AI catalogue entry. They are the obvious next
  ones and each needs its own dimensions; a guardrail in particular is a policy resource whose cost
  is per text unit
- Do not model prompt caching, cross-region inference profiles, or committed provisioned throughput
  terms. Only the no-commitment provisioned rate is priced, and the others are reported as unpriced
- Do not model SageMaker Savings Plans
- Do not measure real model latency or call any model. Every latency figure here is a declared
  assumption, and Epic #11 is where predictions meet measurements
- Do not add the invoke permission to any role beyond the one `callerRoleId` names, and do not emit an
  `aws.iam.Role`. The Bedrock policy attaches to a role the document already contains
- Do not add a model picker or an assumptions form to `apps/web`; the estimate panel is the web epic
  (#12)
- Do not change `packages/core/src/analysis/architecture.ts`, which already proposes both kinds
- Do not touch `packages/core/src/codegen/pulumi.ts` or `terraform.ts`
- Do not remove the catalogue's `overrides` entries in `packages/core/src/services/ai.ts` that mark
  cost-sizing properties as non-arguments; the legacy emitter still reads them

### Dependencies

Blocked by `docs/issues/epic-2-ir/040-resource-contract-registry.md`,
`docs/issues/epic-2-ir/050-edge-and-network-contracts.md` for the widened contract module and the
price lookup, `docs/issues/epic-2-ir/060-compute-contracts.md` for `CapacityModel` and `coldStart`,
and `docs/issues/epic-2-ir/070-data-store-contracts.md` for the `s3_bucket` kind that
`SM-SEC-001` inspects. Blocked by
`docs/issues/epic-7-prediction/010-price-list-snapshot.md` (#8), whose offer list this issue extends.
Consumed by `docs/issues/epic-7-prediction/020-cost-model.md`,
`docs/issues/epic-7-prediction/030-latency-model.md` and
`docs/issues/epic-7-prediction/040-bottleneck-solver.md` (#8).

### Verification

```bash
pnpm --filter @infracanvas/ir-schema generate && git diff --exit-code
pnpm --filter @infracanvas/ir-schema test
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core typecheck
uv run --directory services/brain mypy
node scripts/ci/build-price-snapshot.mjs --check
pnpm lint
```

### Risk Tier

tier:1 - the Bedrock contract emits an IAM policy, and an over-scoped `bedrock:InvokeModel` grant is
a security finding rather than a cost one. Gate 7 derives tier from paths and does not cover
`packages/core/src/resources/`, so the label is set here deliberately and a security review is
expected on the emitted policy.

### Size

size:l - over 600 lines
