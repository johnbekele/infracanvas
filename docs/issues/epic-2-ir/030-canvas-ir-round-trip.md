---
title: '[ir] Lossless canvas and IR round trip in packages/core'
labels: tier:2, size:m, area:ir, epic:2-ir
---

### Epic

#3

### Context

The IR is the document that cost, latency, reliability, Well-Architected rules, and code generation
read. The canvas is a projection of it that React Flow can render. Everything downstream of the
canvas therefore depends on one property: converting an architecture to the canvas and back must not
change it. Without that, an architecture that has been dragged around the screen is a different
architecture from the one that was priced, and the user is shown a cost for a design they no longer
have.

The canvas shape and the IR shape genuinely differ, and pretending otherwise is what makes these
conversions rot. Three differences are real and are resolved here rather than left to callers.
React Flow requires a parent node to appear in the array before its children and stores a child's
position relative to its parent, so ordering and coordinate frame are part of the contract, not an
implementation detail. The catalogue in `aws-services.ts` has two spellings of a VPC, the legacy
`vpc` service node and the `vpc-environment` container, which must collapse onto one IR kind. And a
single canvas `ecs` node today carries both `clusterName` and `serviceName`, while the IR models
`ecs_cluster` and `ecs_service` as separate nodes, because a cluster with two services is a normal
architecture the current shape cannot express.

Because of those differences, losslessness is defined over normalised graphs rather than over raw
input: `normaliseIr(canvasToIr(irToCanvas(ir)))` deep-equals `normaliseIr(ir)`, and
`normaliseCanvas(irToCanvas(canvasToIr(graph)))` deep-equals `normaliseCanvas(graph)`. Normalisation
sorts nodes and edges by id, rounds positions to integers, collapses the legacy `vpc` spelling, and
expands a legacy `ecs` node into a cluster and a service. The alternative was to require exact
equality on raw input, which sounds stronger and is not: it would force the IR to carry the canvas's
historical spellings forever, and the first fixture that uses the legacy form would fail a test that
is really complaining about the catalogue rather than about the conversion.

Nodes the canvas cannot render are refused rather than dropped. Four IR kinds have no entry in
`aws-services.ts` today (`internet_gateway`, `security_group`, `cloudwatch_log_group`,
`secretsmanager_secret`), and a conversion that silently omitted them would produce a canvas that
prices differently from the IR it came from. `irToCanvas` throws `CanvasConversionError` naming the
kinds, which turns a silent correctness bug into a failing test the day a generator starts emitting
one of them.

Spec: `docs/DELIVERY.md`

### Contract

```typescript
// packages/core/src/ir/canvas.ts
import type { ArchitectureIr, IrNode, IrProblem, ResourceKind } from '@infracanvas/ir-schema';
import type { Viewport } from '../types';

export type CanvasNodeType =
  | 'service'
  | 'vpc-environment'
  | 'public-subnet'
  | 'private-subnet'
  | 'ecs-cluster';

/** Replaces `ServiceNodeData.properties`. `params` is discriminated by `kind`. */
export interface IrNodeData<K extends ResourceKind = ResourceKind> {
  kind: K;
  name: string;
  params: Extract<IrNode, { kind: K }>['params'];
  /** Presentation resolved from the catalogue rather than stored, so it cannot drift from it. */
  service: {
    serviceId: string;
    serviceName: string;
    shortName: string;
    color: string;
    category: string;
  };
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  /** Relative to `parentNode` when nested, absolute otherwise, as React Flow expects. */
  position: { x: number; y: number };
  parentNode?: string;
  style?: { width: number; height: number };
  data: IrNodeData;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
  data: { kind: 'connects' | 'depends_on' | 'routes_to' };
}

export interface CanvasGraph {
  /** Parents always precede their children. React Flow drops a child mounted before its parent. */
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  meta: { irVersion: string; name: string; provider: 'aws'; region: string };
}

export function irToCanvas(ir: ArchitectureIr): CanvasGraph;
export function canvasToIr(graph: CanvasGraph): ArchitectureIr;

export function normaliseIr(ir: ArchitectureIr): ArchitectureIr;
export function normaliseCanvas(graph: CanvasGraph): CanvasGraph;

export class CanvasConversionError extends Error {
  readonly problems: IrProblem[];
}
```

```typescript
// packages/core/src/ir/kind-map.ts
/** Undefined for a kind the canvas has no catalogue entry for. */
export function kindToServiceId(kind: ResourceKind): string | undefined;
/** Undefined for a catalogue entry with no IR kind, which must not happen and is asserted in tests. */
export function serviceIdToKind(serviceId: string): ResourceKind | undefined;
```

The mapping is explicit rather than derived from string similarity:

| IR kind        | canvas `serviceId`                 | canvas node type      |
| -------------- | ---------------------------------- | --------------------- |
| `vpc`          | `vpc-environment` (also `vpc`)     | `vpc-environment`     |
| `subnet`       | `public-subnet` / `private-subnet` | matches `params.tier` |
| `ecs_cluster`  | `ecs`                              | `ecs-cluster`         |
| `ecs_service`  | `ecs`                              | `service`             |
| `ec2_instance` | `ec2`                              | `service`             |
| `alb`          | `alb`                              | `service`             |

Behaviour that the signatures do not carry:

- `canvasToIr` runs `validateIr` on its output and throws `CanvasConversionError` with the problems
  attached rather than returning a document that the brain will reject later.
- `irToCanvas` emits nodes in topological order over `parent`, and rejects a document whose parent
  chain contains a cycle even though `validateIr` should already have caught it, because this function
  is also called with documents assembled in memory by `proposeArchitecture`.
- A legacy `ecs` canvas node with no `ecs-cluster` parent becomes two IR nodes, the cluster taking the
  deterministic id `${node.id}-cluster`, so re-running the conversion produces the same ids.
- Positions are rounded to integers on the way into the IR. React Flow produces sub-pixel floats
  while dragging, and storing them makes every drag a document change.

### Files

- CREATE `packages/core/src/ir/canvas.ts`
- CREATE `packages/core/src/ir/kind-map.ts`
- CREATE `packages/core/src/ir/normalise.ts`
- CREATE `packages/core/src/ir/canvas.test.ts`
- CREATE `packages/core/src/ir/round-trip.test.ts`
- CREATE `packages/core/src/ir/kind-map.test.ts`
- MODIFY `packages/core/package.json` - depend on `@infracanvas/ir-schema` with `workspace:*`
- MODIFY `packages/core/src/index.ts` - export the conversions, the types, and the error
- MODIFY `packages/core/src/types.ts` - mark `DesignNode.properties` and `ServiceNodeData.properties`
  as superseded by `IrNodeData.params`, with a comment naming the replacement. Do not delete them

### Acceptance Criteria

- [ ] `normaliseIr(canvasToIr(irToCanvas(ir)))` deep-equals `normaliseIr(ir)` for every fixture in `packages/ir-schema/fixtures`
- [ ] `normaliseCanvas(irToCanvas(canvasToIr(graph)))` deep-equals `normaliseCanvas(graph)` for every canvas fixture
- [ ] A four-level VPC, subnet, cluster, service chain survives the round trip with every `parent` intact
- [ ] Child positions stay relative to their parent in both directions, verified on a node nested two levels deep
- [ ] `irToCanvas` returns nodes with every parent at a lower index than its children
- [ ] `irToCanvas` throws `CanvasConversionError` naming the kind when a node has no catalogue entry
- [ ] `canvasToIr` throws `CanvasConversionError` carrying `validateIr` problems when its output would be invalid
- [ ] A canvas node whose `parentNode` names a node not present is rejected rather than converted to a root node
- [ ] Edge `label`, `sourceHandle`, and `targetHandle` survive both directions unchanged

### Required Tests

- `round trips every ir fixture without loss`
- `round trips a canvas graph through the ir and back`
- `preserves the vpc subnet cluster service containment chain`
- `keeps child positions relative to their parent`
- `orders parents before children so react flow can mount them`
- `expands a legacy single ecs node into a cluster and a service with stable ids`
- `collapses both vpc spellings onto one ir kind`
- `refuses to convert an ir kind the canvas cannot render`
- `rejects a canvas node whose parent is missing rather than emitting an orphan`

### Performance Budget

Each direction converts a 500-node document in under 20ms, measured with `performance.now()` in
`round-trip.test.ts`. The conversion runs on the canvas's interactive path, so it must stay well
inside a frame budget at the sizes a user can actually draw.

### Out of Scope

- Do not migrate `apps/web` to these types. The designer store, `ServiceNode`, and the properties
  panel move in the web epic (#12), and doing it here turns a 400-line change into an unreviewable one
- Do not change `packages/core/src/codegen/terraform.ts` or `pulumi.ts` to read `params`. The emitters
  are replaced per resource by the Resource Contract in `040-resource-contract-registry.md`
- Do not delete `DesignNode.properties` or `ServiceNodeData.properties` while `apps/web` still reads
  them; a comment marking them superseded is the whole change to `types.ts`
- Do not add resource kinds to `aws-services.ts` to make the four unrenderable kinds convertible.
  Refusing them is the specified behaviour
- Do not change the schema or the generated types; a change needed there means this issue is blocked

### Dependencies

Blocked by `docs/issues/epic-2-ir/010-architecture-ir-schema.md` and
`docs/issues/epic-2-ir/020-ir-type-generation.md`. Nothing open blocks it; the canvas migration that
consumes it is tracked in the web epic #12.

### Verification

```bash
pnpm --filter @infracanvas/ir-schema build
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core typecheck
pnpm --filter @infracanvas/core build
pnpm lint
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
