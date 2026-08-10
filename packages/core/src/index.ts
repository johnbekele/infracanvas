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
  ancestors,
  containersFirst,
  isProvisionable,
  parentLinks,
  placementOf,
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
