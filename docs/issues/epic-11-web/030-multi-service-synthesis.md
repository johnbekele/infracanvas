---
title: '[core] Propose one architecture node per deployable, not one per repository'
labels: tier:2, size:l, area:web, epic:11-ui
---

### Epic

#12

### Context

`proposeArchitecture` cannot describe a repository that deploys more than one thing. It reads
`profile.dependencies` and `profile.containerisation` and never reads `profile.components`, then
emits nodes at fixed identifiers: `node-compute`, `node-database`, `node-cache`. A repository with
seven services and two databases produces the same single ECS box as a repository with one, and the
only acknowledgement is a gap that says as much in prose.

The fixed template is also why the output is uninformative rather than merely incomplete. A single
box labelled ECS is not a smaller version of the right answer; it is a different answer, and it hides
exactly the decisions -- how many services, which of them face the internet, which share a database
-- that the user came to make.

With schema v2 the profile carries what a per-deployable synthesis needs. This issue rewrites the
engine around it: each deployable becomes its own node, shared infrastructure is derived once, and
every node states the files it was inferred from and how confident that inference is.

The engine stays deterministic. The same profile must yield the same proposal, because the proposal
is what a Pulumi program is generated from and what a cost model prices. Model-driven refinement
arrives later, on top of this, and is validated against it.

Spec: `docs/issues/epic-11-web/020-per-component-analysis.md`

### Contract

```typescript
// packages/core/src/analysis/architecture.ts
export type Confidence = 'high' | 'medium' | 'low';

export interface ProposedNode {
  id: string;
  serviceId: string;
  position: { x: number; y: number };
  parentId?: string;
  size?: { width: number; height: number };
  properties: Record<string, string | number | boolean>;
  /** Repository paths this node was inferred from. */
  evidence: string[];
  confidence: Confidence;
  /** The component this node deploys, when it deploys one. */
  componentPath?: string;
}

export function proposeArchitecture(
  profile: AppProfile,
  repositoryName: string
): ArchitectureProposal;
```

Synthesis rules, applied per deployable:

```
api        -> one ECS service in a private subnet, one ALB target group, one listener rule
worker     -> one ECS service in a private subnet, no ALB edge, edge to the queue it consumes
frontend   -> one S3 bucket and one CloudFront distribution, outside the VPC
ml-service -> SageMaker endpoint when the stack is inference-only, GPU-capable ECS otherwise
cron       -> EventBridge schedule and an ECS task
```

Shared infrastructure, derived once per repository:

```
one RDS per distinct relational compose service, or one when only a driver is known
ElastiCache when redis is used, OpenSearch or RDS pgvector when vector search is used
SQS when any worker exists, Bedrock and Secrets Manager when an LLM API is used
S3 when object storage is used
```

Containment is `vpc-environment > {public,private}-subnet > ecs-cluster > service`. Container sizes
are computed from child count rather than taken from fixed constants.

### Files

- MODIFY `packages/core/src/analysis/architecture.ts` -- deployable-driven synthesis
- CREATE `packages/core/src/analysis/layout.ts` -- computed placement and container sizing
- CREATE `packages/core/src/analysis/layout.test.ts`
- MODIFY `packages/core/src/analysis/architecture.test.ts`
- CREATE `packages/core/src/analysis/fixtures/monorepo.ts` -- a profile shaped like a real monorepo
- MODIFY `apps/web/src/components/analysis/ArchitectureProposalPanel.tsx` -- evidence and confidence
- MODIFY `apps/web/src/lib/architecture/to-flow.ts` -- carry evidence and confidence onto node data

### Acceptance Criteria

- [ ] A profile with six deployable services yields six compute nodes, each naming its component
- [ ] A worker has no edge from the load balancer
- [ ] A worker consuming a queue has an edge to it
- [ ] Two frontends yield two bucket and distribution pairs, not one shared pair
- [ ] Two distinct relational compose services yield two database nodes
- [ ] A relational driver with no compose service yields exactly one database node
- [ ] Every node carries at least one evidence path, or is marked as a structural default
- [ ] A node inferred from a compose service is `high` confidence; one inferred from a driver alone is `medium`
- [ ] Compute nodes sit inside a cluster, which sits inside a private subnet, which sits inside the VPC
- [ ] Containers are sized to fit their children, with no child overlapping another
- [ ] The same profile yields a byte-identical proposal on repeated runs
- [ ] A capability with no service in the catalog is still reported as a gap

### Required Tests

- `emits one compute node per deployable component`
- `keeps workers off the load balancer path`
- `connects a worker to the queue it consumes`
- `emits a bucket and distribution per frontend`
- `emits one database per distinct relational compose service`
- `falls back to a single database when only a driver is known`
- `marks a compose-derived node as high confidence and a driver-derived node as medium`
- `nests compute inside a cluster inside a private subnet`
- `grows a container to fit more children than fit the default size`
- `does not overlap two nodes in the same container`
- `is deterministic: the same profile yields the same proposal`
- `still reports MongoDB as a gap rather than substituting another database`

### Performance Budget

Synthesis of a profile with 40 components completes in under 50 ms, so the panel stays interactive
without a worker. The resulting canvas stays within the Gate 6 500-node budget.

### Out of Scope

- Model-driven refinement of the proposal; this engine stays deterministic
- Cost, latency, and SLO prediction for the proposed architecture
- Generating Pulumi code from the proposal or deploying it
- Adding new services to the catalog; this issue proposes only what the catalog already has, and
  reports the rest as gaps

### Dependencies

Blocked by #47.

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/core test
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines; the engine is rewritten rather than extended
