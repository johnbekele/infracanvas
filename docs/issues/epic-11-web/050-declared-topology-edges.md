---
title: '[core] Draw the topology a compose file declares instead of guessing it'
labels: tier:2, size:m, area:web, epic:11-ui
---

### Epic

#12

### Context

`apps/api/src/lib/analysis/compose.ts` parses `depends_on` and the profile carries it on every
`ComposeService`. `proposeArchitecture` never reads it. Every edge in a proposal is instead derived
from capability overlap: if a component declares a Postgres driver, it is wired to every Postgres node
in the proposal.

For a repository that names two databases in compose, that is wrong in a way the user can see at a
glance. A billing service and a reporting service both declare `pg`, so both are drawn against both
databases -- four edges where the compose file states two. The repository wrote down its own topology
and the diagram ignored it.

Overlap is still the only thing available for the repositories that declare nothing, which is most of
them, so it stays. What changes is precedence: where a repository states a dependency, the statement
is drawn and the guess is not.

The two kinds of edge also have to be told apart on screen. A declared edge is a fact about the
repository; an inferred one is a proposal the user may know to be wrong, and if both are drawn
identically the user has to re-derive which is which before they can review either.

### Contract

```typescript
export type EdgeOrigin = 'declared' | 'inferred';

export interface ProposedEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** `declared` for a compose `depends_on`; `inferred` for anything this engine derived. */
  origin: EdgeOrigin;
}
```

Resolution rules:

- A `depends_on` entry resolves through the compose service name to the node that stands for it: the
  compute node of the component it builds, or the managed node that replaced its image.
- A declared edge is emitted before any inferred edge, so where both describe the same pair the
  declared one is what remains.
- Where a component's compose service declares any dependency, that list is treated as complete for
  the services compose names: an inferred edge to another compose-derived node is dropped. Nodes with
  no compose service behind them -- a bucket, a queue, a model API -- are unaffected, because a
  compose file cannot declare them.
- A `depends_on` naming a compose service that produced no node is reported as a gap. A name that
  appears in no compose service is ignored, since it is a typo or an unread override rather than a
  dropped dependency.

On the canvas an inferred edge is dashed and a declared edge solid, and the proposal panel states how
many of each there are and which is which.

### Files

- MODIFY `packages/core/src/analysis/architecture.ts` - resolve declarations, mark every edge
- MODIFY `packages/core/src/index.ts` - export `EdgeOrigin`
- MODIFY `packages/core/src/analysis/architecture.test.ts`
- MODIFY `apps/web/src/lib/architecture/to-flow.ts` - dash the inferred edges
- CREATE `apps/web/src/lib/architecture/to-flow.test.ts`
- CREATE `apps/web/src/lib/architecture/edge-provenance.ts`
- CREATE `apps/web/src/lib/architecture/edge-provenance.test.ts`
- MODIFY `apps/web/src/components/analysis/ArchitectureProposalPanel.tsx` - say where the edges came from

### Acceptance Criteria

- [ ] An edge stated by `depends_on` appears in the proposal and is marked `declared`
- [ ] A declared dependency on an off-the-shelf image resolves to the managed node that replaced it
- [ ] Where a component declares its dependencies, no extra edge is guessed to another compose service
- [ ] An inferred edge to a node compose cannot name, such as a bucket, survives a declaration
- [ ] A repository that declares nothing keeps every edge capability overlap produced
- [ ] Every edge carries an origin, so none is silently ambiguous
- [ ] A declared dependency that could not be drawn is reported as a gap
- [ ] A dependency naming a service no compose file declares produces no gap and no edge
- [ ] The canvas draws inferred edges dashed and declared edges solid
- [ ] The proposal panel says how many connections were declared and how many inferred

### Required Tests

- `draws the edge the compose file declares`
- `marks a declared edge as declared`
- `does not guess the connection the declaration leaves out`
- `resolves a declaration onto the node that replaced the container`
- `still infers a connection to a service compose cannot name`
- `reports a declared dependency it could not draw`
- `says nothing about a dependency naming a service compose never declared`
- `falls back to capability overlap`
- `marks every edge it guessed as inferred`
- `draws a declared connection solid`
- `draws an inferred connection dashed`
- `says how many connections the repository declared`
- `says nothing about a proposal with no connections`

### Performance Budget

n/a - resolution is one pass over the compose services in a profile that already sits in memory,
and synthesis runs once per analysis. The existing determinism test covers the shape of the output.

### Out of Scope

- Do not read anything else out of compose: `networks`, `volumes`, and healthcheck conditions imply
  nothing this catalog can draw yet
- Do not treat `depends_on` as a startup ordering constraint for generated code
- Do not add a node for a compose service the catalog has no service for; report the gap instead
- Do not change how nodes are chosen, laid out, or given confidence

### Dependencies

none

### Verification

```bash
pnpm lint
pnpm turbo typecheck
pnpm turbo test
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
