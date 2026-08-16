---
title: '[ir] Validator dispatches every typed kind, and exports the RDS types'
labels: tier:2, size:s, area:ir, epic:2-ir
---

### Epic

#3

### Context

`validateIr` reports a `oneOf` failure by re-validating the offending node against the single branch
its `kind` names, so the problem pointer lands on the parameter the author got wrong rather than on
three branches they cannot act on. `BRANCH_BY_KIND` in `packages/ir-schema/src/validate.ts` builds
that map from a hand-written list:

```typescript
for (const [def, kinds] of [
  ['vpcNode', ['vpc']],
  ['subnetNode', ['subnet']],
  ['pendingContractNode', pendingKinds()],
] as const) {
```

`rds_instance` is typed, so it is not in `pendingKinds()`, and it is not in the list. The lookup
misses, the code falls into its `!branch` path, and a malformed RDS parameter is reported as
`/nodes/N/kind: "rds_instance" is not a resource kind this schema version knows` — which is both
untrue and the wrong place to look. No fixture covers it, so nothing catches it.

The list is the defect, not the missing row. `docs/issues/epic-2-ir/` queues typed parameters for the
remaining twenty-one kinds, and each one that lands leaves the pending enum, finds no branch here,
and inherits the same wrong error. Adding `rdsInstanceNode` to the list fixes one kind and leaves
twenty-one traps.

The same schema walk that `typedContractKinds()` already performs — over
`properties.nodes.items.oneOf`, resolving each `$ref` to a `$defs` name and reading that branch's
`properties.kind.const` — yields exactly the def-name-to-kind mapping this map needs. Deriving it
there means a kind cannot gain typed parameters without gaining its branch validator in the same
edit. `typedContractKinds()`'s own docstring already makes the argument for deriving rather than
listing: _"a list here would be a fourth that nobody remembers until a resource silently prices as an
untyped bag."_

Separately and for the same reason of the reader being sent to the wrong place:
`packages/ir-schema/src/index.ts` exports `VpcNode`, `VpcParams`, `SubnetNode`, `SubnetParams` and
`SubnetTier` but not `RdsInstanceNode`, `RdsInstanceParams` or `RdsEngine`. A consumer that wants RDS
parameters has to reach them through `Extract<IrNode, { kind: 'rds_instance' }>['params']`, which is
what `ParamsOf<K>` in `packages/core/src/resources/contract.ts` does. The types are generated and
present; only the re-export is missing.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```typescript
// packages/ir-schema/src/validate.ts
//
// BRANCH_BY_KIND is derived from the document's own oneOf. A branch naming one
// kind claims that kind; the branch naming none is the untyped one and claims
// every kind still awaiting a contract.
const BRANCH_BY_KIND = new Map<string, ValidateFunction>();

// packages/ir-schema/src/index.ts — added to the existing generated-type re-export
export type { RdsEngine, RdsInstanceNode, RdsInstanceParams } from './generated/types.js';
```

No change to the schema, to `VERSION`, or to the generated files. This issue does not bump the IR
version, because no document that validated before validates differently after — only the message
changes.

### Files

- `packages/ir-schema/src/validate.ts` — MODIFY: build `BRANCH_BY_KIND` by walking
  `schemaJson.properties.nodes.items.oneOf` instead of the hand-written list; state in the docstring
  why it is derived.
- `packages/ir-schema/src/index.ts` — MODIFY: re-export `RdsEngine`, `RdsInstanceNode`,
  `RdsInstanceParams`.
- `packages/ir-schema/fixtures/invalid/rds-storage-below-minimum.json` — CREATE: an `rds_instance`
  whose `allocatedStorageGb` is 10, below the schema's minimum of 20. It carries no `parent` and no
  edges, so the storage parameter is the only thing wrong with it.
- `packages/ir-schema/src/validate.test.ts` — MODIFY: add the dispatch case below.

### Acceptance Criteria

- [ ] A malformed `rds_instance` parameter produces a problem whose pointer is the parameter, not the node's `kind`.
- [ ] No problem reported for a malformed `rds_instance` claims the kind is unknown.
- [ ] Every kind returned by `typedContractKinds()` has an entry in the branch map.
- [ ] `RdsEngine`, `RdsInstanceNode` and `RdsInstanceParams` are importable from `@infracanvas/ir-schema`.
- [ ] The new invalid fixture is rejected by the TypeScript validator and by the generated Pydantic models.
- [ ] `packages/ir-schema/VERSION` is unchanged.

### Required Tests

- `rejects an rds parameter by naming the parameter, not the kind` — validates the new fixture,
  asserts a problem with pointer `/nodes/0/params/allocatedStorageGb` and source `schema`, and asserts
  no problem message contains the phrase `resource kind`. Must fail against the current implementation.
- `every typed kind has a branch validator` — iterates `typedContractKinds()` and asserts each one
  dispatches, so a kind typed in a later issue cannot silently lose its validator.
- `test_pydantic_rejects_every_fixture_the_schema_rejects[rds-storage-below-minimum.json]` — the
  existing parametrised parity suite in `services/brain/tests/test_ir_models.py` picks the new fixture
  up automatically; it must reject it on shape, so the fixture must not be added to `REFERENTIAL_ONLY`.
- The existing `validate.test.ts` cases must pass unchanged, in particular the vpc and subnet
  parameter cases that prove the derived map still dispatches the kinds the list used to cover.

### Performance Budget

`validate.test.ts` already budgets a 500-node document at 40 ms. The map is built once at module load
and is the same size as before, so that budget must hold with no change.

### Out of Scope

- Typing parameters for any of the twenty-one pending kinds.
- The `unevaluatedProperties` fidelity gap between the JSON Schema and the generated Pydantic models,
  which `services/brain/src/brain/ir/__init__.py` documents and which is a generator limitation.
- Correcting the `irVersion` of the existing invalid fixtures, which declare `1.0.0` while the valid
  ones declare `1.1.0`.
- Any change to `validateIr`'s referential pass.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/ir-schema exec vitest run src/validate.test.ts
uv run --directory services/brain pytest tests/test_ir_models.py
pnpm --filter @infracanvas/ir-schema exec tsc --noEmit
```

Confirm the new case is not vacuous by running it against the implementation it replaces; it must
report `"rds_instance" is not a resource kind this schema version knows`:

```bash
git stash push -- packages/ir-schema/src/validate.ts
pnpm --filter @infracanvas/ir-schema exec vitest run src/validate.test.ts -t "naming the parameter"
git stash pop
```
