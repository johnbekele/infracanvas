// InfraCanvas Core - AWS Service Definitions and Code Generators

// Types
export * from './types';

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
