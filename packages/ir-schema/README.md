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

Landing a contract therefore moves one string from `pendingContractKind` to a typed branch of its
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

Three files come out of that command, and all three are committed:

| File                                    | From                                         |
| --------------------------------------- | -------------------------------------------- |
| `src/generated/ir-version.ts`           | `VERSION` and the schema `$id`               |
| `src/generated/types.ts`                | `json-schema-to-typescript`                  |
| `services/brain/src/brain/ir/models.py` | `datamodel-code-generator`, run through `uv` |

Committing generated code costs a mechanical diff on every schema change and buys a reviewable one:
a reviewer sees what a schema edit did to the public surface of both languages. Gate 4 regenerates
and fails on any diff, so a hand edit is caught, but only after a round trip through CI. Change the
schema or the generator instead.

Both generators are formatted by this repository's own formatters as the last step - Prettier for
the TypeScript, the brain's pinned Ruff for the Python - so what the generator writes is what
`pnpm format:check` and `ruff format --check` expect, and neither tool updating can start a fight
with the other.

The Python models are generated into `services/brain` rather than into a second Python distribution
here. The brain is the only Python consumer, so a distribution would buy nothing and cost a
`pyproject.toml`, an editable install, and a packaging step in every workflow that touches Python.
Generating into the brain also gets the models type-checked by its `mypy --strict` run for free.

One fidelity note. The schema forbids unknown properties on a node with `unevaluatedProperties`,
which `datamodel-code-generator` does not implement, so the Python node models ignore an unknown key
where the schema rejects the document. Parameter objects and the document root do forbid extras in
both languages, and `validateIr` remains the authority every document crosses on its way in.
