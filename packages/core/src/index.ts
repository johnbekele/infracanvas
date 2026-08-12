// InfraCanvas Core - AWS Service Definitions and Code Generators

// Types
export * from './types';

// Repository analysis
export {
  PROFILE_SCHEMA_VERSION,
  componentsWith,
  deployables,
  hasCapability,
  isContainerised,
  isCurrentProfile,
  isDeployableKind,
  primaryLanguage,
  profileCapabilities,
  type AppProfile,
  type Capability,
  type Component,
  type ComponentKind,
  type ComposeService,
  type Containerisation,
  type DependencyCategory,
  type DetectedDependency,
  type Ecosystem,
  type LanguageBreakdown,
  type OutdatedProfile,
} from './analysis/profile';

export {
  GAP,
  MIN_CONTAINER,
  NODE_SIZE,
  PADDING,
  columnsFor,
  type Position,
  type Size,
} from './analysis/layout';

export {
  proposeArchitecture,
  type ArchitectureDecision,
  type ArchitectureProposal,
  type Confidence,
  type EdgeOrigin,
  type ProposedEdge,
  type ProposedNode,
} from './analysis/architecture';

// AWS Services
export {
  awsServices,
  serviceCategories,
  getServiceById,
  getServicesByCategory,
  canConnect,
  type AWSService,
  type IacArgument,
  type IacMapping,
  type ServiceCategory,
  type ServiceProperty,
  type SubnetPlacement,
} from './aws-services';

export {
  emitPulumi,
  emitTerraform,
  argumentNameFor,
  identifierFor,
  snakeCase,
  type EmitNode,
  type EmitOptions,
  type ParentContext,
} from './codegen/emit';

export {
  ZONE_PROPERTY,
  ancestors,
  containersFirst,
  isProvisionable,
  parentLinks,
  placedProperties,
  placementOf,
  zoneNameOf,
  type HierarchyNode,
  type Placement,
} from './codegen/hierarchy';

// Code Generators
export {
  generateTerraform,
  generateTerraformProject,
  type TerraformFile,
  type TerraformProject,
} from './codegen/terraform';

export {
  generatePulumi,
  generatePulumiProject,
  type PulumiFile,
  type PulumiProject,
} from './codegen/pulumi';

// ZIP Export
export { exportTerraformZip, exportPulumiZip, downloadBlob } from './codegen/zip';

// Model providers and reasoning scale
export {
  llmProviders,
  getProvider,
  isLlmProvider,
  type LlmProvider,
  type ProviderInfo,
} from './llm/providers';

export {
  reasoningParams,
  reasoningScales,
  isReasoningScale,
  type ReasoningScale,
} from './llm/reasoning';

// Architecture IR and the canvas projection of it
export {
  CanvasConversionError,
  canvasToIr,
  clusterIdFor,
  irToCanvas,
  type CanvasEdge,
  type CanvasGraph,
  type CanvasNode,
  type CanvasNodeType,
  type IrNodeData,
} from './ir/canvas';

// Re-exported so a consumer can hold an IR document without depending on the
// schema package, which carries a JSON Schema validator no browser needs.
export { IR_VERSION } from '@infracanvas/ir-schema';
export type { ArchitectureIr, IrEdge, IrNode, ResourceKind } from '@infracanvas/ir-schema';

export {
  canvasTypeForNode,
  kindToServiceId,
  serviceIdForNode,
  serviceIdToKind,
  unrenderableKinds,
} from './ir/kind-map';

export { normaliseCanvas, normaliseIr } from './ir/normalise';

// The typed patch: how anything other than the canvas proposes a change
export {
  applyPatch,
  invertPatch,
  IR_PATCH_VERSION,
  IrPatchError,
  MAX_OPS_PER_PATCH,
  type IrParamValue,
  type IrPatch,
  type IrPatchOp,
  type PatchProblem,
  type PatchResult,
} from './ir/patch';

export { canonicalJson, irDigest, patchDigest, semanticEncoding } from './ir/digest';

// Resource contracts: cost, latency, reliability, rules and emitters per kind
export {
  annualDowntimeMinutes,
  DEFAULT_USAGE,
  EmitReferenceError,
  evaluateArchitecture,
  getResourceContract,
  HOURS_PER_MONTH,
  kindsWithoutContract,
  listResourceContracts,
  rdsInstanceContract,
  registerBuiltInResources,
  registerResource,
  resetResourceRegistry,
  usd,
  type ArchitectureFindings,
  type CostComponent,
  type CostEstimate,
  type EmitContext,
  type LatencyContribution,
  type ParamsOf,
  type Pillar,
  type PulumiFragment,
  type ReliabilityContribution,
  type ResourceContract,
  type RuleContext,
  type RuleFinding,
  type Severity,
  type UsageAssumptions,
  type WellArchitectedRule,
} from './resources';

// Prediction: what an architecture costs, and the assumptions behind the figure
export {
  DEFAULT_ASSUMPTIONS,
  defaultAssumptions,
  SERVICE_TIME_PREFIX,
  UnknownAssumptionError,
  USAGE_ASSUMPTION_IDS,
  usageFor,
  withOverride,
  type Assumption,
  type AssumptionId,
  type AssumptionSet,
} from './prediction';

export {
  costArchitecture,
  costContext,
  costModel,
  predicted,
  reviseAssumption,
  rollUpCost,
  type ArchitectureCost,
  type CostContext,
  type CostLine,
  type Prediction,
  type ResourceCost,
  type Revision,
} from './prediction';

// Availability composed from published SLAs, and the objectives it can support
export {
  availability,
  availabilityContext,
  AWS_SLAS,
  DEFAULT_AZ_CORRELATION,
  findSla,
  MINUTES_PER_MONTH,
  parallelAvailability,
  proposeSlos,
  seriesAvailability,
  SLO_LADDER,
  type AvailabilityContext,
  type AvailabilityNode,
  type AvailabilityReport,
  type PathLatencySummary,
  type ServiceSla,
  type SliDefinition,
  type SloProposal,
} from './prediction';

// Prediction: how slow the architecture is as it fills up, resource by resource
export {
  arrivalRateFrom,
  composePath,
  DEFAULT_LAMBDA_CONCURRENCY,
  DEFAULT_SERVICE_TIMES_MS,
  erlangC,
  GRID_POINTS,
  kingmanFactor,
  latencyContext,
  latencyContribution,
  pathLatency,
  SATURATION_THRESHOLD,
  sequentialPath,
  sojournPercentile,
  sojournSurvival,
  withArrivalRate,
  type ComposedSegment,
  type Distribution,
  type Grid,
  type LatencyContext,
  type PathLatency,
  type PathSegment,
  type QueueContribution,
  type QueueInput,
  type QueueModel,
} from './prediction';

// Prediction: which component gives way first, and at what request rate
export {
  ANY_SERVICE,
  AWS_LIMITS,
  bottleneckContext,
  concurrency,
  findBottleneck,
  limitApplies,
  limitsFor,
  limitValueFor,
  MAX_BISECTIONS,
  residenceSeconds,
  RPS_CEILING,
  RPS_TOLERANCE,
  solveBreakingRps,
  utilisationAt,
  withTargetRps,
  type Bottleneck,
  type BottleneckContext,
  type BottleneckReport,
  type ServiceLimit,
} from './prediction';
