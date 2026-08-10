# @infracanvas/ir-schema

The architecture IR is the document everything else reads: the canvas renders it, the code
generators emit from it, and the cost, latency, availability and Well-Architected models all price
and check it. This package holds the schema that defines it and the validator every consumer shares.

The authority is `schema/architecture-ir.schema.json`, a JSON Schema (draft 2020-12), not a
TypeScript type. Two languages consume the IR — TypeScript on the canvas and in the generators,
Python in `services/brain` — and a schema neither language owns is the only version of this that
does not make one of them a translation of the other's build artefact.

## Using it

```typescript
import { validateIr, assertValidIr } from '@infracanvas/ir-schema';

const result = validateIr(candidate);
if (!result.valid) {
  for (const problem of result.problems) {
    console.error(`${problem.pointer}: ${problem.message}`);
  }
}
```

`validateIr` never throws, whatever it is handed. `assertValidIr` is the same check for call sites
that cannot branch, and throws `IrValidationError` with the same problems attached.

Validation happens in two passes. The first is the schema: shape, required properties, parameter
types per resource kind. The second is the rules JSON Schema cannot express — an edge naming a node
that does not exist, a containment cycle, a duplicate id, a subnet outside a VPC. Problems from the
second pass carry `source: 'reference'`, because a document that passes the schema and fails these
is exactly the document that generates infrastructure code referencing a resource nobody declared.

## Typed and pending kinds

`$defs/resourceKind` lists every kind the IR knows. Only some of them have typed parameters; the
rest sit in the `pendingContractNode` branch, whose `params` is still an untyped bag of scalars.

That split is deliberate. A kind's parameter set is only trustworthy once its resource contract
exists to consume it — the cost model, the latency contribution, the rules and the emitter, all
specified in `docs/issues/epic-2-ir/040-resource-contract-registry.md`. Typing all two dozen kinds
before any of them is priced would be several thousand lines of JSON asserting things nothing reads.

Landing a contract therefore moves one string from `pendingContractNode` to a typed branch of its
own, and a test asserts that every kind appears in exactly one of the two lists, so they cannot
drift apart.

## Versioning

`VERSION` and the schema's `$id` carry the same version, and a test fails when they disagree. Gate 4
also compares changes under `schema/` against `VERSION` and fails a pull request that moved one
without the other, but a gate is a slow way to find out, so the same invariant is a unit test.

- **Patch** — an error message, a description, anything a consumer cannot observe.
- **Minor** — an added optional property, or a kind moving from pending to typed. Documents valid
  before are still valid.
- **Major** — anything that invalidates a document that used to be valid. This needs a migration for
  stored architectures, so it is not a decision to take inside another issue.

## Regenerating

```bash
pnpm --filter @infracanvas/ir-schema generate
```

Everything under `src/generated/` is written by that command and committed. Do not hand-edit it:
Gate 4 regenerates and fails on any diff, so an edit there is found, but only after a round trip
through CI. Change the schema or the generator instead.
