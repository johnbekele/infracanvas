// InfraCanvas Core - AWS Service Definitions and Code Generators

// Types
export * from './types';

// Repository analysis
export {
  PROFILE_SCHEMA_VERSION,
  profileCapabilities,
  hasCapability,
  isContainerised,
  primaryLanguage,
  type AppProfile,
  type Capability,
  type Component,
  type ComponentKind,
  type Containerisation,
  type DependencyCategory,
  type DetectedDependency,
  type Ecosystem,
  type LanguageBreakdown,
} from './analysis/profile';

export {
  proposeArchitecture,
  type ArchitectureDecision,
  type ArchitectureProposal,
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
  type ServiceProperty,
  type SubnetPlacement,
} from './aws-services';

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
