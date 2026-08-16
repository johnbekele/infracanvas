# Resource contracts

Every downstream feature asks the same seven questions of a resource: what parameters it takes, what
it costs, what it adds to end-to-end latency, what it does to availability, which Well-Architected
rules apply, what infrastructure code it emits, and what output is known-good. A `ResourceContract`
holds all seven answers in one place.

The value is in the shape being enforced. A resource missing its latency model cannot be registered,
rather than being registered and silently contributing zero to every estimate a user is shown.

## The seven parts

| Part          | File             | What it must not do                                                   |
| ------------- | ---------------- | --------------------------------------------------------------------- |
| Parameters    | the IR schema    | Live here. `paramsDef` names the `$defs` entry, and a test checks it  |
| `cost`        | `cost.ts`        | Call a network. Prices come from a committed snapshot with provenance |
| `latency`     | `latency.ts`     | Model saturation. That is the bottleneck solver's question            |
| `reliability` | `reliability.ts` | Return a constant where a parameter changes the answer                |
| `rules`       | `rules.ts`       | Throw. A rule returns null when it passes, including on absent params |
| `emitPulumi`  | `emit.ts`        | Guess at another node's variable name. Ask `refFor`, which throws     |
| Golden output | `__golden__/`    | Be regenerated without reading the diff                               |

## Adding a resource

`rds-instance/` is the reference, and the choice was deliberate: it is the only resource in the
catalogue that exercises all seven parts non-trivially. Its cost has two components with different
units, its availability changes measurably with `multiAz`, and it has three checkable rules across
three pillars. A resource modelled from an easier reference would not have needed a cost breakdown at
all.

1. Type the parameters in `packages/ir-schema/schema/architecture-ir.schema.json`: add a
   `<kind>Params` definition and a `<kind>Node` branch, remove the kind from `pendingContractKind`,
   add the branch to the document's `oneOf`, and bump `packages/ir-schema/VERSION`.
2. Regenerate both languages with `pnpm --filter @infracanvas/ir-schema generate`, and add the new
   node type to `packages/ir-schema/src/nodes.ts` and `services/brain/src/brain/ir/__init__.py`.
3. Copy the `rds-instance/` directory and replace each part. Keep one file per part: a single
   `contract.ts` per resource is how the cost model ends up sharing a closure with the emitter.
4. Register it in `registerBuiltInResources`.

`registry.test.ts` asserts that `kindsWithoutContract()` equals the schema's pending list, so step 1
without steps 3 and 4 fails the suite rather than shipping a kind nothing can price.

## Cost provenance

`CostEstimate.priceSource` names the snapshot file, the AWS price list version, and the date it was
captured. Every figure the canvas shows can be traced to a published price list, which is what makes
"we predicted this" a claim rather than an assertion.

A model reports what it could not price in `unpriced` rather than treating it as free. A cost that
quietly omits provisioned IOPS is more damaging than one that admits it does not know.
