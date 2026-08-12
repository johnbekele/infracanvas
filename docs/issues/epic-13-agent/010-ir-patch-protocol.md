---
title: '[ir] Typed IR patch that applies whole or not at all and inverts exactly'
labels: tier:2, size:m, area:ir, epic:13-agent
---

### Epic

#117

### Context

Every edit to an architecture today is an in-place mutation of a Zustand store.
`apps/web/src/lib/stores/designer-store.ts` spreads a new value into `node.data.properties` in
`updateNodeProperty`, filters an array in `removeNode`, and rewrites `parentNode` in `reparentNode`.
Nothing records what changed, nothing can undo it beyond React Flow's delete key, and nothing checks
the result against a schema, because there is no schema: canvas nodes carry
`properties: Record<string, string | number | boolean>` and the Architecture IR in
`docs/issues/epic-2-ir/010-architecture-ir-schema.md` is specified but not built. That is tolerable
while a human is doing the dragging, because a human sees the result. It is not tolerable once
something else proposes the change, which is what this epic is.

Two alternatives were considered and rejected. The first was to have the copilot return a whole IR
document that the server validates and stores. It is the least code, and it is wrong: a request to
make one database Multi-AZ arrives as a rewrite of the entire document, so the artefact a user has to
approve is a diff of two several-hundred-line JSON files in which a silently dropped node looks much
like a reordered array. It also cannot be inverted without retaining a snapshot of every version.
The second was to let the copilot write infrastructure code or prose that a later step interprets.
That is refused by the epic outright: nothing can validate it, and the moment generated Pulumi is the
copilot's output the deterministic engine in `packages/core/src/analysis/architecture.ts` stops being
the thing that decides what the architecture is.

Typed operations give the three properties the epic needs. Each operation names the nodes it touches,
so the canvas can highlight the blast radius before the user accepts anything. Each is invertible
against the document it applied to, so reverting is `applyPatch(ir, invertPatch(ir, patch))` rather
than a snapshot restore. Snapshot restore was considered here specifically and rejected: a user who
drags a node while a proposal is open would have that drag reverted too, because a snapshot cannot
tell the copilot's change from the user's own.

**A patch is rejected whole rather than partially applied.** Validation runs once, on the finished
document, not after each operation, because intermediate states are legitimately invalid: removing
the edges that point at a node leaves the document referentially fine, but removing the node first
does not. Per-operation preconditions are checked against the intermediate document as the operation
is applied; the schema and reference rules are checked at the end by the same `validateIr` the canvas
uses. If either fails, the input document is returned untouched and the caller gets problems.

Nothing in this issue knows that a model exists. `applyPatch` and `invertPatch` are pure functions
over two JSON documents with no I/O, no clock and no randomness, which is what makes them testable on
their own and what lets the property-based round trip below be meaningful. The Python side never
reimplements them: `services/brain` sends operations and the TypeScript applies them, through the
surfaces in `020-copilot-tool-surface.md` and `050-copilot-sse-endpoint.md`.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```typescript
// packages/core/src/ir/patch.ts
import type { ArchitectureIr, IrEdge, IrNode, ResourceKind } from '@infracanvas/ir-schema';

export const IR_PATCH_VERSION = 1;

/** `null` clears an optional parameter, which is what makes `set_param` invertible both ways. */
export type IrParamValue = string | number | boolean | null;

export type IrPatchOp =
  | { op: 'add_node'; node: IrNode }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'set_param'; nodeId: string; param: string; value: IrParamValue }
  | { op: 'add_edge'; edge: IrEdge }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'move_node'; nodeId: string; parent: string | null }
  | {
      op: 'replace_kind';
      nodeId: string;
      kind: ResourceKind;
      /** Complete parameters for the new kind. The old ones are not merged in. */
      params: Record<string, IrParamValue>;
    };

export interface IrPatch {
  patchVersion: typeof IR_PATCH_VERSION;
  /**
   * `irDigest` of the document this patch was computed against. `applyPatch`
   * refuses any other document, so a proposal cannot land on an architecture
   * that moved underneath it.
   */
  basedOnIrDigest: string;
  /** One sentence, rendered on the diff card. Never read by any decision. */
  summary: string;
  ops: IrPatchOp[];
}

export interface PatchProblem {
  /** Index into `ops`; -1 for a problem with the patch as a whole. */
  opIndex: number;
  /** JSON Pointer into the resulting document, for example `/nodes/3/params/multiAz`. */
  pointer: string;
  message: string;
  /**
   * `patch` for a malformed patch, `precondition` for an operation the document
   * does not permit, `schema` and `reference` as `validateIr` reports them.
   */
  source: 'patch' | 'precondition' | 'schema' | 'reference';
}

export type PatchResult =
  | {
      ok: true;
      ir: ArchitectureIr;
      /** Every node id an operation added, removed, re-parented or edited, deduplicated and sorted. */
      touchedNodeIds: string[];
    }
  | { ok: false; problems: PatchProblem[] };

/** Applies every operation in order, then validates once. Never mutates `ir`. */
export function applyPatch(ir: ArchitectureIr, patch: IrPatch): PatchResult;

/**
 * The patch that undoes `patch`, computed against the document it applied to.
 * `basedOnIrDigest` on the result is the digest of the *patched* document.
 * Throws `IrPatchError` when `patch.basedOnIrDigest` does not match `ir`, since
 * an inverse derived from the wrong pre-image is worse than no inverse.
 */
export function invertPatch(ir: ArchitectureIr, patch: IrPatch): IrPatch;

/** SHA-256 over the canonical semantic encoding described below. */
export function irDigest(ir: ArchitectureIr): string;

/** SHA-256 over canonical JSON of the patch, with `summary` excluded. */
export function patchDigest(patch: IrPatch): string;

export class IrPatchError extends Error {
  readonly problems: PatchProblem[];
}

/** A larger edit is a redesign, not a patch, and nobody can review it on a card. */
export const MAX_OPS_PER_PATCH = 50;
```

Preconditions and inverses, stated per operation so two implementations cannot differ:

| Operation      | Precondition                                                                         | Inverse                                             |
| -------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `add_node`     | `node.id` is not present; `node.parent` is present or null                           | `remove_node` of that id                            |
| `remove_node`  | node is present; no remaining edge and no remaining node references it               | `add_node` of the removed node, verbatim            |
| `set_param`    | node is present; `param` is a string of at least one character                       | `set_param` back to the previous value, or `null`   |
| `add_edge`     | `edge.id` is not present; source and target are present                              | `remove_edge` of that id                            |
| `remove_edge`  | edge is present                                                                      | `add_edge` of the removed edge, verbatim            |
| `move_node`    | node is present; `parent` is present or null; the new parent chain contains no cycle | `move_node` back to the previous parent             |
| `replace_kind` | node is present; `kind` differs from the current kind                                | `replace_kind` back to the previous kind and params |

`remove_node` deliberately refuses to cascade. A patch that deletes a database has to name the four
edges it also deletes, which makes the inverse exact and stops a one-line operation hiding its own
blast radius on the diff card. The ordering that satisfies the precondition -- edges first, then the
node -- is the patch author's problem, and `020-copilot-tool-surface.md` returns the precondition
failure to the model so it can reorder rather than guess.

`replace_kind` keeps the node's `id`, `name`, `parent` and `layout`, replaces `kind` and `params`
wholesale, and leaves edges alone. Whether the surviving edges make sense for the new kind is a
question `validateIr` and the Well-Architected rules answer, not this function.

**`irDigest` is computed over the semantics, not the picture.** The encoding is
`normaliseIr(ir)` from `docs/issues/epic-2-ir/030-canvas-ir-round-trip.md` with every `layout` object
and the whole `presentation` object removed, then canonical JSON with sorted keys and no whitespace.
Including layout would mean that dragging a node invalidates every open proposal, and a user
rearranging the canvas while reading a suggestion is normal behaviour rather than a conflict.

The property-based round trip needs generated documents rather than a handful of fixtures, because
the interesting failures are in operation sequences nobody thought to write down -- a `move_node`
followed by a `remove_node` of the old parent, a `set_param` on a parameter a later `replace_kind`
deletes. `fast-check` is added as a dev dependency of `packages/core` for this. A hand-rolled
generator was considered and rejected: shrinking a failing 12-operation sequence to its minimal case
is the entire value, and that is the part nobody writes by hand.

```typescript
// packages/core/src/ir/patch-round-trip.test.ts, in outline
fc.assert(
  fc.property(arbitraryIr(), arbitraryOps(), (ir, ops) => {
    const patch = { patchVersion: 1, basedOnIrDigest: irDigest(ir), summary: '', ops };
    const forward = applyPatch(ir, patch);
    fc.pre(forward.ok);
    const back = applyPatch(forward.ir, invertPatch(ir, patch));
    expect(back.ok).toBe(true);
    expect(irDigest(back.ir)).toBe(irDigest(ir));
    expect(normaliseIr(back.ir)).toEqual(normaliseIr(ir));
  }),
  { numRuns: 500 }
);
```

### Files

- CREATE `packages/core/src/ir/patch.ts` - the types, `applyPatch`, `invertPatch`, `IrPatchError`
- CREATE `packages/core/src/ir/patch-ops.ts` - one table of per-operation apply and invert functions
- CREATE `packages/core/src/ir/digest.ts` - `irDigest`, `patchDigest`, canonical JSON encoding
- CREATE `packages/core/src/ir/patch.test.ts`
- CREATE `packages/core/src/ir/digest.test.ts`
- CREATE `packages/core/src/ir/patch-round-trip.test.ts` - the property-based suite
- CREATE `packages/core/src/ir/__fixtures__/patches/multi-az.json` - a `set_param` patch
- CREATE `packages/core/src/ir/__fixtures__/patches/add-cache.json` - node plus two edges
- CREATE `packages/core/src/ir/__fixtures__/patches/invalid/orphan-edge.json` - fails `validateIr`
- CREATE `packages/core/src/ir/__fixtures__/patches/invalid/remove-referenced-node.json` - fails a precondition
- MODIFY `packages/core/src/index.ts` - export the patch surface and the digests
- MODIFY `packages/core/package.json` - add `fast-check` as a dev dependency

### Acceptance Criteria

- [ ] `applyPatch` returns the input document unchanged, by reference identity, when any operation fails
- [ ] A patch whose result fails `validateIr` is rejected whole, with the validator problems carried through as `source: 'schema'` or `'reference'`
- [ ] A patch that removes the edges pointing at a node and then the node succeeds, proving validation runs once at the end rather than per operation
- [ ] `remove_node` of a node an edge still references fails with `source: 'precondition'` and names the edge
- [ ] `applyPatch` refuses a patch whose `basedOnIrDigest` does not match `irDigest(ir)`, without inspecting the operations
- [ ] `set_param` with `null` removes the parameter, and its inverse restores the previous value
- [ ] `applyPatch(ir, invertPatch(ir, patch))` applied to the patched document reproduces `irDigest(ir)` for every fixture patch
- [ ] The property-based suite finds no operation sequence over 500 generated cases where the round trip loses information
- [ ] `irDigest` is unchanged by moving a node's `layout` or the viewport, and changes when any `params` value changes
- [ ] `patchDigest` is unchanged by editing `summary` and changes when any operation changes
- [ ] A patch with more than `MAX_OPS_PER_PATCH` operations is rejected with `opIndex: -1`
- [ ] `move_node` that would make a node its own ancestor fails with a precondition rather than recursing

### Required Tests

- `applies a set_param patch and leaves the input document untouched`
- `rejects the whole patch when one operation fails a precondition`
- `rejects the whole patch when the result would fail validateIr`
- `removes edges and then the node they referenced in one patch`
- `refuses to remove a node an edge still references`
- `refuses a patch computed against a different document`
- `clears an optional parameter with null and restores it on inversion`
- `inverts every fixture patch back to the original digest`
- `round trips every generated operation sequence` (property-based)
- `ignores layout and viewport when digesting a document`
- `excludes the summary from the patch digest`
- `rejects a patch longer than the operation ceiling`
- `refuses a move that would make a node its own ancestor`

### Performance Budget

`applyPatch` with a 20-operation patch against a 500-node document completes in under 5ms excluding
the `validateIr` call, which carries its own 10ms budget from
`docs/issues/epic-2-ir/010-architecture-ir-schema.md`; `invertPatch` in under 2ms; `irDigest` in under
5ms. All measured over 100 iterations with `performance.now()` and asserted on the median, because a
preview recomputes all three on every proposal and `030-patch-preview-deltas.md` has an interactive
budget to meet. The property-based suite completes 500 runs in under 20 seconds so it can stay in the
default `pnpm test` rather than behind a flag.

### Out of Scope

- Do not compute cost, availability or Well-Architected deltas; `030-patch-preview-deltas.md` owns the
  preview and the diff against the current document
- Do not add any tool, prompt, model call or Pydantic model; `020-copilot-tool-surface.md` owns that
  boundary, and this file staying LLM-free is what makes it testable
- Do not wire the canvas to patches, and do not touch `apps/web/src/lib/stores/designer-store.ts`.
  The store keeps its own mutators until `060-copilot-chat-surface.md` lands
- Do not add an undo stack, a revision table, or history persistence. `invertPatch` is the mechanism;
  where inverses are stored is `050-copilot-sse-endpoint.md`
- Do not change `packages/core/src/analysis/architecture.ts`. It keeps producing the baseline
  proposal, and a patch is applied to the IR that proposal becomes
- Do not extend the IR schema. An operation this protocol cannot express means the schema is the thing
  that has to change, in its own issue, with a version bump

### Dependencies

Blocked by #77 for `validateIr` and the document shape, #78 for the generated `IrNode`, `IrEdge` and
`ResourceKind` types, and #79 for `normaliseIr`, which the digest is defined in terms of. Nothing in
this issue depends on the prediction plane or on `services/brain`.

### Verification

```bash
pnpm install
pnpm --filter @infracanvas/ir-schema build
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core typecheck
pnpm --filter @infracanvas/core build
pnpm lint
node -e "const c=require('./packages/core/dist/index.js');const ir=require('./packages/ir-schema/fixtures/three-tier.json');console.log(c.irDigest(ir))"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
