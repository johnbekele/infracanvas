---
title: '[ir] Versioned architecture IR JSON Schema as the single authority'
labels: tier:2, size:m, area:ir, epic:2-ir
---

### Epic

#3

### Context

An architecture on the canvas is currently a `DesignNode` with
`properties: Record<string, string | number | boolean>`, and every consumer re-guesses that bag's
keys. `packages/core/src/codegen/pulumi.ts` reads `props.instanceType`,
`packages/core/src/codegen/terraform.ts` reads the same key independently, and
`packages/core/src/analysis/architecture.ts` writes it from the catalogue defaults in
`aws-services.ts`. Nothing connects the three. Renaming a property produces generated Terraform that
is quietly wrong rather than a type error, and cost, latency, reliability, and Well-Architected
checks are all about to read the same bag. This issue defines the typed document that replaces it.

The authority is a JSON Schema (draft 2020-12) under `packages/ir-schema/schema/`, not a TypeScript
definition. Two languages consume the IR: the canvas and the code generators in TypeScript, and the
cost, prediction, and profile agents in `services/brain`. The alternative considered was defining the
IR in Zod inside `packages/core` and deriving JSON Schema from it with `zod-to-json-schema`, which is
more pleasant for the web code. It was rejected because it makes the Python models a translation of a
build artefact of the other language's type system: the emitted schema flattens `$ref` reuse, its
shape depends on the Zod version, and any disagreement is discovered in the brain at runtime rather
than in CI. With a neutral schema, both languages are generated and both can be diffed against it.

The version is deliberately load-bearing. `.github/workflows/gate-contract.yml` already contains an
`ir-version` job that compares changes under `packages/ir-schema/schema` against
`packages/ir-schema/VERSION` and fails when the schema moved and the version did not; it logs a
notice and passes today because the directory does not exist. Landing this package is what makes that
gate live. Because a gate that only fires on a pull request is a slow feedback loop, the same
invariant is also asserted as a unit test: the schema's `$id` embeds the version string, and a test
reads `VERSION` and compares them, so an agent that edits the schema and runs `pnpm test` finds out
immediately.

The schema types node parameters per resource kind, but not for all twenty-four kinds at once. Doing
so is several thousand lines of JSON and violates the one-issue-one-session rule, and the parameter
sets are only trustworthy once each resource's cost model and emitter exist to consume them, which is
the Resource Contract in `docs/issues/epic-2-ir/040-resource-contract-registry.md`. Instead the node
schema is a `oneOf` over per-kind branches plus one explicit `pendingContract` branch whose `kind`
enum lists the kinds that are not yet typed. The untyped bag therefore survives only where it is
named, and a contract landing moves one string from one list to the other. This issue types `vpc` and
`subnet`, because containment cannot be validated without them.

Spec: `docs/DELIVERY.md`

### Contract

`packages/ir-schema/schema/architecture-ir.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://infracanvas.dev/schema/architecture-ir/1.0.0.json",
  "title": "ArchitectureIr",
  "type": "object",
  "additionalProperties": false,
  "required": ["irVersion", "name", "provider", "region", "nodes", "edges"],
  "properties": {
    "irVersion": { "type": "string", "pattern": "^1\\.\\d+\\.\\d+$" },
    "name": { "type": "string", "minLength": 1, "maxLength": 128 },
    "provider": { "const": "aws" },
    "region": { "type": "string", "pattern": "^[a-z]{2}(-gov)?-[a-z]+-[0-9]$" },
    "nodes": {
      "type": "array",
      "items": {
        "oneOf": [
          { "$ref": "#/$defs/vpcNode" },
          { "$ref": "#/$defs/subnetNode" },
          { "$ref": "#/$defs/pendingContractNode" }
        ]
      }
    },
    "edges": { "type": "array", "items": { "$ref": "#/$defs/edge" } },
    "presentation": { "$ref": "#/$defs/presentation" }
  },
  "$defs": {
    "resourceId": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,62}$" },
    "resourceKind": {
      "enum": [
        "vpc",
        "subnet",
        "internet_gateway",
        "nat_gateway",
        "security_group",
        "ec2_instance",
        "lambda_function",
        "ecs_cluster",
        "ecs_service",
        "alb",
        "nlb",
        "api_gateway",
        "cloudfront_distribution",
        "route53_zone",
        "s3_bucket",
        "rds_instance",
        "dynamodb_table",
        "elasticache_cluster",
        "sns_topic",
        "sqs_queue",
        "iam_role",
        "cognito_user_pool",
        "cloudwatch_log_group",
        "secretsmanager_secret"
      ]
    },
    "layout": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x", "y"],
      "properties": {
        "x": { "type": "integer" },
        "y": { "type": "integer" },
        "width": { "type": "integer", "minimum": 1 },
        "height": { "type": "integer", "minimum": 1 }
      }
    },
    "nodeBase": {
      "type": "object",
      "required": ["id", "kind", "name", "params"],
      "properties": {
        "id": { "$ref": "#/$defs/resourceId" },
        "name": { "type": "string", "minLength": 1, "maxLength": 128 },
        "parent": { "oneOf": [{ "$ref": "#/$defs/resourceId" }, { "type": "null" }] },
        "layout": { "$ref": "#/$defs/layout" }
      }
    },
    "vpcNode": {
      "allOf": [{ "$ref": "#/$defs/nodeBase" }],
      "unevaluatedProperties": false,
      "properties": {
        "kind": { "const": "vpc" },
        "params": {
          "type": "object",
          "additionalProperties": false,
          "required": ["cidrBlock"],
          "properties": {
            "cidrBlock": { "type": "string", "format": "ipv4-cidr" },
            "enableDnsHostnames": { "type": "boolean", "default": true },
            "enableDnsSupport": { "type": "boolean", "default": true }
          }
        }
      }
    },
    "subnetNode": {
      "allOf": [{ "$ref": "#/$defs/nodeBase" }],
      "unevaluatedProperties": false,
      "properties": {
        "kind": { "const": "subnet" },
        "params": {
          "type": "object",
          "additionalProperties": false,
          "required": ["tier", "cidrBlock", "availabilityZone"],
          "properties": {
            "tier": { "enum": ["public", "private"] },
            "cidrBlock": { "type": "string" },
            "availabilityZone": { "type": "string", "minLength": 1 }
          }
        }
      }
    },
    "pendingContractNode": {
      "allOf": [{ "$ref": "#/$defs/nodeBase" }],
      "unevaluatedProperties": false,
      "properties": {
        "kind": {
          "enum": [
            "internet_gateway",
            "nat_gateway",
            "security_group",
            "ec2_instance",
            "lambda_function",
            "ecs_cluster",
            "ecs_service",
            "alb",
            "nlb",
            "api_gateway",
            "cloudfront_distribution",
            "route53_zone",
            "s3_bucket",
            "rds_instance",
            "dynamodb_table",
            "elasticache_cluster",
            "sns_topic",
            "sqs_queue",
            "iam_role",
            "cognito_user_pool",
            "cloudwatch_log_group",
            "secretsmanager_secret"
          ]
        },
        "params": {
          "type": "object",
          "additionalProperties": { "type": ["string", "number", "boolean"] }
        }
      }
    },
    "edge": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "kind", "source", "target"],
      "properties": {
        "id": { "$ref": "#/$defs/resourceId" },
        "kind": { "enum": ["connects", "depends_on", "routes_to"] },
        "source": { "$ref": "#/$defs/resourceId" },
        "target": { "$ref": "#/$defs/resourceId" },
        "label": { "type": "string", "maxLength": 64 },
        "sourceHandle": { "type": "string" },
        "targetHandle": { "type": "string" }
      }
    },
    "presentation": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "viewport": {
          "type": "object",
          "additionalProperties": false,
          "required": ["x", "y", "zoom"],
          "properties": {
            "x": { "type": "number" },
            "y": { "type": "number" },
            "zoom": { "type": "number", "exclusiveMinimum": 0 }
          }
        }
      }
    }
  }
}
```

`format: ipv4-cidr` is a custom format registered on the validator; JSON Schema's built-in formats do
not cover CIDR, and rejecting `10.0.0/16` at the document boundary is worth one line of validator
setup.

Referential rules that JSON Schema cannot express are enforced by the validator, not left to
consumers:

```typescript
// packages/ir-schema/src/validate.ts
export interface IrProblem {
  /** JSON Pointer into the document, for example `/nodes/3/params/cidrBlock`. */
  pointer: string;
  message: string;
  /** `schema` for a JSON Schema violation, `reference` for the graph rules below. */
  source: 'schema' | 'reference';
}

export type IrValidationResult =
  | { valid: true; document: ArchitectureIr }
  | { valid: false; problems: IrProblem[] };

/** Validates shape, then node references. Never throws for malformed input. */
export function validateIr(input: unknown): IrValidationResult;

/** Throws `IrValidationError` with the same problems attached. For call sites that cannot branch. */
export function assertValidIr(input: unknown): ArchitectureIr;

export const IR_VERSION: string; // read from VERSION at build time
export const IR_SCHEMA_ID: string;
```

The reference rules: every `edge.source` and `edge.target` names an existing node; every
`node.parent` names an existing node; the parent chain contains no cycle; node ids are unique and
edge ids are unique; a `subnet` node's parent is a `vpc`.

`packages/ir-schema/package.json` declares the two scripts the gates invoke:

```json
{
  "name": "@infracanvas/ir-schema",
  "scripts": {
    "generate": "node scripts/generate.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsup"
  }
}
```

`scripts/generate.mjs` in this issue emits only `src/generated/ir-version.ts`, containing
`IR_VERSION` and `IR_SCHEMA_ID` read from `VERSION` and the schema's `$id`. Gate 4's `schema-drift`
job runs `pnpm --filter @infracanvas/ir-schema generate` and fails on any diff the moment this
directory exists, so the script must exist and be meaningful from the first commit. Types and Pydantic
models extend the same script in `docs/issues/epic-2-ir/020-ir-type-generation.md`.

### Files

- CREATE `packages/ir-schema/package.json`
- CREATE `packages/ir-schema/VERSION` - `1.0.0`
- CREATE `packages/ir-schema/tsconfig.json`
- CREATE `packages/ir-schema/tsup.config.ts`
- CREATE `packages/ir-schema/README.md` - what the version means and when to bump it
- CREATE `packages/ir-schema/schema/architecture-ir.schema.json`
- CREATE `packages/ir-schema/scripts/generate.mjs`
- CREATE `packages/ir-schema/src/index.ts`
- CREATE `packages/ir-schema/src/validate.ts`
- CREATE `packages/ir-schema/src/generated/ir-version.ts` - generated, committed
- CREATE `packages/ir-schema/src/validate.test.ts`
- CREATE `packages/ir-schema/src/version.test.ts`
- CREATE `packages/ir-schema/fixtures/minimal.json`
- CREATE `packages/ir-schema/fixtures/three-tier.json` - VPC, two subnets, and nodes of pending kinds
- CREATE `packages/ir-schema/fixtures/invalid/unknown-parent.json`
- CREATE `packages/ir-schema/fixtures/invalid/parent-cycle.json`
- CREATE `packages/ir-schema/fixtures/invalid/duplicate-node-id.json`
- CREATE `packages/ir-schema/fixtures/invalid/extra-vpc-param.json`

### Acceptance Criteria

- [ ] `validateIr` returns `{ valid: true }` with the parsed document for every fixture under `fixtures/` that is not in `fixtures/invalid/`
- [ ] `validateIr` returns `{ valid: false }` with a JSON Pointer for every fixture under `fixtures/invalid/`
- [ ] `validateIr(undefined)` and `validateIr('{}')` return `{ valid: false }` rather than throwing
- [ ] A `vpc` node carrying a parameter the schema does not declare is rejected, naming that parameter in the pointer
- [ ] A `subnet` whose `parent` is another `subnet` is rejected
- [ ] An edge referencing a node id that no node declares is rejected with `source: 'reference'`
- [ ] Every value in `resourceKind` appears in exactly one of the typed branches or the `pendingContract` branch, asserted by a test rather than by review
- [ ] Editing the schema without editing `VERSION` fails `pnpm --filter @infracanvas/ir-schema test`
- [ ] `pnpm --filter @infracanvas/ir-schema generate` twice in a row leaves the working tree clean

### Required Tests

- `accepts every valid fixture`
- `rejects a document with an edge pointing at a missing node`
- `rejects a parent cycle rather than recursing until the stack overflows`
- `rejects a vpc parameter that the schema does not declare`
- `rejects a subnet whose parent is not a vpc`
- `rejects a cidr block that is not valid ipv4 notation`
- `returns problems rather than throwing when given a non-object`
- `reports every resource kind as either contracted or pending exactly once`
- `fails when the schema id and the version file disagree`

### Performance Budget

`validateIr` on a 500-node document completes in under 10ms, measured with `performance.now()` in
`validate.test.ts`. The validator is compiled once at module load rather than per call, because the
canvas validates on every save.

### Out of Scope

- Do not generate TypeScript types or Pydantic models here; that is `020-ir-type-generation.md`, and
  splitting them keeps the schema reviewable on its own
- Do not add conversion to or from the canvas shape; that is `030-canvas-ir-round-trip.md`
- Do not type the twenty-two pending kinds. Each arrives with its Resource Contract
- Do not modify `packages/core/src/types.ts` or either code generator. They keep reading the property
  bag until the round trip lands
- Do not edit `.github/workflows/gate-contract.yml`. Its `ir-version` and `schema-drift` jobs already
  guard on this directory and become live without a change
- Do not add the `ir` column validation in `analyses` or `experiments`; #27 explicitly defers it

### Dependencies

none

### Verification

```bash
pnpm install
pnpm --filter @infracanvas/ir-schema generate && git diff --exit-code
pnpm --filter @infracanvas/ir-schema test
pnpm --filter @infracanvas/ir-schema typecheck
pnpm --filter @infracanvas/ir-schema build
pnpm lint
node -e "const {validateIr}=require('./packages/ir-schema/dist/index.js');console.log(validateIr(require('./packages/ir-schema/fixtures/three-tier.json')).valid)"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
