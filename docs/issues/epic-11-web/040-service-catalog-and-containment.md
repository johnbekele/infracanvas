---
title: '[core] Declarative service catalog with AI services and real containment'
labels: tier:2, size:l, area:web, epic:11-ui
---

### Epic

#12

### Context

The catalog holds 21 services in six categories and not one of them is an AI, ML or analytics
service. A repository that depends on `torch` and `transformers` is correctly detected as running
inference and then has nowhere to go, because the catalog it is matched against has no Bedrock, no
SageMaker, no vector store. The same is true of most of what a real system is built from: no EKS, no
Aurora, no Kinesis, no Secrets Manager, no EventBridge.

The catalog cannot simply be extended, because each service is wired into code generation by hand.
`terraform.ts` is 760 lines of per-service emitters for 21 services, and `pulumi.ts` covers 10
services in TypeScript and 6 in Python out of the same 21. Adding 50 more services that way means
roughly 3000 lines of near-identical emitter code and guarantees that the catalog and the generated
code drift apart, which is worse than a small catalog: an architecture that exports to a Pulumi
program full of `# TODO` is a false promise.

So the mapping moves into the catalog entry. A service declares its Terraform resource and its
Pulumi class along with how its properties map to arguments, and one generic emitter reads that
declaration for every service. Adding a service becomes a data change with a test, not three
parallel code changes.

Containment has the same shape of problem. `vpc-environment` and the subnets are real container
nodes, but parenting is only ever assigned at the moment a service is dropped from the palette.
`setNodeParent` exists in the store with no call sites, so a service already on the canvas can never
be moved into a VPC. Code generation then ignores the hierarchy entirely and emits every node as an
independent module, so a design that looks correctly nested produces Terraform with no subnet
references at all.

### Contract

```typescript
// packages/core/src/aws-services.ts
export type ServiceCategory =
  | 'compute'
  | 'storage'
  | 'database'
  | 'networking'
  | 'security'
  | 'integration'
  | 'ai-ml'
  | 'analytics'
  | 'observability';

/** How one canvas property becomes one IaC argument. */
export interface PropertyMapping {
  /** The property name on the node. */
  from: string;
  /** The Terraform argument name. */
  terraform: string;
  /** The Pulumi argument name, in each language's casing. */
  pulumi: { ts: string; python: string };
  /** Omit the argument when the value equals the property default. */
  omitWhenDefault?: boolean;
}

export interface IacMapping {
  terraformResource: string;
  pulumiClass: { ts: string; python: string };
  properties: PropertyMapping[];
  /** Arguments taken from the containing node, e.g. `subnet_id` from the parent subnet. */
  fromParent?: { argument: string; parentOutput: string }[];
}

export interface AWSService {
  id: string;
  name: string;
  shortName: string;
  category: ServiceCategory;
  description: string;
  color: string;
  icon: string;
  allowedConnections: string[];
  properties: ServiceProperty[];
  iac: IacMapping;
  isContainer?: boolean;
  /** Container types this service may be placed in, innermost first. */
  allowedParents?: string[];
  subnetPlacement?: SubnetPlacement;
}
```

```typescript
// packages/core/src/codegen/emit.ts -- one emitter, driven by the catalog
export function emitTerraformResource(node: DesignNode, hierarchy: Hierarchy): string;
export function emitPulumiResource(
  node: DesignNode,
  hierarchy: Hierarchy,
  lang: 'ts' | 'python'
): string;
```

New container services: `ecs-cluster`, `eks-cluster`, `availability-zone`, `security-group`.

New `ai-ml` services: `bedrock`, `bedrock-knowledge-base`, `bedrock-agent`, `bedrock-guardrail`,
`sagemaker-endpoint`, `sagemaker-training`, `opensearch-vector`, `kendra`, `textract`, `comprehend`,
`rekognition`, `transcribe`, `polly`, `translate`.

Remaining gaps filled: `eks`, `fargate`, `app-runner`, `batch`, `aurora`, `aurora-serverless`,
`documentdb`, `neptune`, `redshift`, `msk`, `kinesis`, `eventbridge`, `step-functions`, `glue`,
`athena`, `secrets-manager`, `kms`, `waf`, `acm`, `cloudwatch`, `x-ray`, `ecr`, `efs`, `appsync`,
`amplify`, `vpc-endpoint`.

### Files

- MODIFY `packages/core/src/aws-services.ts` -- declarative `iac`, new categories and services
- CREATE `packages/core/src/codegen/emit.ts` -- generic Terraform and Pulumi emitters
- CREATE `packages/core/src/codegen/emit.test.ts`
- MODIFY `packages/core/src/codegen/terraform.ts` -- delegate to the generic emitter
- MODIFY `packages/core/src/codegen/pulumi.ts` -- delegate to the generic emitter
- CREATE `apps/web/src/components/designer/ClusterNode.tsx` -- cluster container node
- MODIFY `apps/web/src/components/designer/DesignerCanvas.tsx` -- reparent on drag stop
- MODIFY `apps/web/src/lib/stores/designer-store.ts` -- auto-grow containers, nesting validation
- MODIFY `apps/web/src/components/designer/ServicePalette.tsx` -- new categories and icons

### Acceptance Criteria

- [ ] Every catalog service declares an `iac` mapping; no service falls through to a TODO comment
- [ ] Generated Terraform for a service in a subnet references that subnet, not a bare resource
- [ ] Generated Pulumi Python covers every catalog service, matching the Terraform resource choice
- [ ] Dragging a service already on the canvas into a subnet reparents it
- [ ] Dragging a service out of a container clears its parent and keeps its on-screen position
- [ ] A service whose `allowedParents` excludes the container under the cursor is not reparented
- [ ] An RDS node cannot be dropped into a public subnet
- [ ] A container grows when a child is dropped near its edge, rather than clipping the child
- [ ] A cluster may contain compute services and may itself sit only in a subnet
- [ ] Every AI/ML capability the profiler can detect maps to a catalog service
- [ ] The service palette lists the new categories with working icons

### Required Tests

- `every catalog service has an iac mapping`
- `emits a subnet reference for a node placed in a subnet`
- `emits the same resource type for terraform and pulumi`
- `generates python for every catalog service`
- `reparents a node dragged into a subnet`
- `clears the parent when a node is dragged onto open canvas`
- `refuses to place a database in a public subnet`
- `refuses to place a subnet inside a subnet`
- `grows a container to contain a child dropped at its edge`
- `keeps a node's screen position when its parent changes`

### Performance Budget

A 500-node canvas keeps 60fps while dragging, and reparent hit-testing stays O(containers) rather
than O(nodes). Initial web JavaScript stays within the Gate 6 budget; the catalog is tree-shakeable
data, and any growth beyond 20 KB gzipped must be loaded on demand.

### Out of Scope

- Deploying the generated code
- Cost or latency attributes on catalog entries; prediction is its own epic
- Icons beyond the existing Lucide set; bespoke AWS iconography is a design task
- Multi-region or multi-account topology on the canvas

### Dependencies

Blocked by #47.

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
```

### Risk Tier

tier:1 - changes code generation, which produces infrastructure

### Size

size:l - over 600 lines; the catalog is data and the emitters replace per-service code
