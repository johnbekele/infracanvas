// AWS Service definitions for InfraCanvas Architecture Designer
//
// The catalog is data, and code generation reads it rather than carrying a
// branch per service. A hand-written emitter per service was why the catalog
// stopped at 21 entries and why Pulumi Python covered six of them: adding a
// service meant three parallel edits, so it did not happen, and the export
// silently degraded to a comment for anything missing.
import { aiServices } from './services/ai';
import { dataServices } from './services/data-stores';
import { integrationServices } from './services/integration';
import { platformServices } from './services/platform';

export interface ServiceProperty {
  name: string;
  label: string;
  type: 'text' | 'select' | 'number' | 'boolean' | 'textarea';
  default: string | number | boolean;
  options?: { value: string; label: string }[];
  description?: string;
  required?: boolean;
}

export interface SubnetPlacement {
  allowedInPublic: boolean;
  allowedInPrivate: boolean;
  requiresSubnet: boolean;
}

/** The argument names a property takes in each target, when they are unusual. */
export interface IacArgument {
  terraform: string;
  pulumi: string;
}

/**
 * How a service becomes infrastructure code.
 *
 * Argument names are derived from property names by convention -- Terraform and
 * Pulumi Python take `snake_case`, Pulumi TypeScript takes `camelCase` -- so a
 * service usually declares only its resource type. `overrides` covers the cases
 * where the provider disagrees with the convention, and a `null` override marks
 * a property that configures the canvas rather than the resource.
 */
export interface IacMapping {
  terraformResource: string;
  /** Pulumi uses the same class path in every language; only arguments differ. */
  pulumiClass: string;
  overrides?: Record<string, IacArgument | null>;
  /** Arguments taken from the container this node sits in. */
  fromParent?: { argument: string; from: 'subnet' | 'vpc' | 'cluster' }[];
}

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
  parentRequired?: string;
  /**
   * Containers this may be placed in, innermost first. Absent means it may sit
   * anywhere, including on open canvas.
   */
  allowedParents?: string[];
  subnetPlacement?: SubnetPlacement;
}

export const serviceCategories = [
  { id: 'compute', name: 'Compute', color: '#FF9900' },
  { id: 'storage', name: 'Storage', color: '#569A31' },
  { id: 'database', name: 'Database', color: '#4053D6' },
  { id: 'ai-ml', name: 'AI & ML', color: '#01A88D' },
  { id: 'analytics', name: 'Analytics', color: '#8C4FFF' },
  { id: 'networking', name: 'Networking', color: '#8C4FFF' },
  { id: 'security', name: 'Security', color: '#DD344C' },
  { id: 'integration', name: 'Integration', color: '#FF4F8B' },
  { id: 'observability', name: 'Observability', color: '#E7157B' },
] as const;

const coreServices: AWSService[] = [
  // Compute
  {
    id: 'ec2',
    name: 'EC2',
    shortName: 'EC2',
    category: 'compute',
    description: 'Virtual servers in the cloud',
    color: '#FF9900',
    icon: 'server',
    allowedConnections: ['rds', 'dynamodb', 's3', 'elasticache', 'sqs', 'sns', 'vpc', 'iam'],
    properties: [
      {
        name: 'instanceName',
        label: 'Instance Name',
        type: 'text',
        default: 'my-instance',
        required: true,
      },
      {
        name: 'instanceType',
        label: 'Instance Type',
        type: 'select',
        default: 't3.micro',
        options: [
          { value: 't3.micro', label: 't3.micro (Free tier)' },
          { value: 't3.small', label: 't3.small (2 vCPU, 2GB)' },
          { value: 't3.medium', label: 't3.medium (2 vCPU, 4GB)' },
          { value: 't3.large', label: 't3.large (2 vCPU, 8GB)' },
          { value: 'm5.large', label: 'm5.large (2 vCPU, 8GB)' },
          { value: 'm5.xlarge', label: 'm5.xlarge (4 vCPU, 16GB)' },
          { value: 'c5.large', label: 'c5.large (Compute optimized)' },
          { value: 'r5.large', label: 'r5.large (Memory optimized)' },
        ],
      },
      {
        name: 'ami',
        label: 'Operating System',
        type: 'select',
        default: 'amazon-linux-2023',
        options: [
          { value: 'amazon-linux-2023', label: 'Amazon Linux 2023' },
          { value: 'amazon-linux-2', label: 'Amazon Linux 2' },
          { value: 'ubuntu-24', label: 'Ubuntu 24.04 LTS' },
          { value: 'ubuntu-22', label: 'Ubuntu 22.04 LTS' },
          { value: 'debian-12', label: 'Debian 12' },
          { value: 'windows-2022', label: 'Windows Server 2022' },
        ],
      },
      { name: 'rootVolumeSize', label: 'Root Volume Size (GB)', type: 'number', default: 30 },
      {
        name: 'rootVolumeType',
        label: 'Volume Type',
        type: 'select',
        default: 'gp3',
        options: [
          { value: 'gp3', label: 'GP3 (General Purpose SSD)' },
          { value: 'gp2', label: 'GP2 (General Purpose SSD)' },
          { value: 'io1', label: 'IO1 (Provisioned IOPS)' },
        ],
      },
      { name: 'publicIp', label: 'Associate Public IP', type: 'boolean', default: true },
      { name: 'keyPair', label: 'Key Pair Name', type: 'text', default: '' },
      { name: 'monitoring', label: 'Detailed Monitoring', type: 'boolean', default: false },
    ],
    iac: {
      terraformResource: 'aws_instance',
      pulumiClass: 'aws.ec2.Instance',
      fromParent: [{ argument: 'subnetId', from: 'subnet' }],
    },
    subnetPlacement: { allowedInPublic: true, allowedInPrivate: true, requiresSubnet: false },
  },
  {
    id: 'lambda',
    name: 'Lambda',
    shortName: 'λ',
    category: 'compute',
    description: 'Serverless compute service',
    color: '#FF9900',
    icon: 'zap',
    allowedConnections: [
      'dynamodb',
      's3',
      'rds',
      'sqs',
      'sns',
      'api-gateway',
      'iam',
      'vpc',
      'cloudfront',
      'elasticache',
      'cognito',
    ],
    properties: [
      {
        name: 'functionName',
        label: 'Function Name',
        type: 'text',
        default: 'my-function',
        required: true,
      },
      {
        name: 'runtime',
        label: 'Runtime',
        type: 'select',
        default: 'nodejs20.x',
        options: [
          { value: 'nodejs20.x', label: 'Node.js 20.x' },
          { value: 'nodejs18.x', label: 'Node.js 18.x' },
          { value: 'python3.12', label: 'Python 3.12' },
          { value: 'python3.11', label: 'Python 3.11' },
          { value: 'java21', label: 'Java 21 (Corretto)' },
          { value: 'go1.x', label: 'Go 1.x' },
          { value: 'dotnet8', label: '.NET 8' },
        ],
      },
      { name: 'handler', label: 'Handler', type: 'text', default: 'index.handler' },
      {
        name: 'memory',
        label: 'Memory (MB)',
        type: 'select',
        default: '256',
        options: [
          { value: '128', label: '128 MB' },
          { value: '256', label: '256 MB' },
          { value: '512', label: '512 MB' },
          { value: '1024', label: '1 GB' },
          { value: '2048', label: '2 GB' },
        ],
      },
      { name: 'timeout', label: 'Timeout (seconds)', type: 'number', default: 30 },
      {
        name: 'architecture',
        label: 'Architecture',
        type: 'select',
        default: 'arm64',
        options: [
          { value: 'arm64', label: 'ARM64 (Graviton2)' },
          { value: 'x86_64', label: 'x86_64' },
        ],
      },
      { name: 'envVars', label: 'Environment Variables', type: 'textarea', default: '' },
      { name: 'enableTracing', label: 'X-Ray Tracing', type: 'boolean', default: false },
    ],
    iac: { terraformResource: 'aws_lambda_function', pulumiClass: 'aws.lambda.Function' },
    subnetPlacement: { allowedInPublic: true, allowedInPrivate: true, requiresSubnet: false },
  },
  {
    id: 'ecs',
    name: 'ECS',
    shortName: 'ECS',
    category: 'compute',
    description: 'Container orchestration service',
    color: '#FF9900',
    icon: 'container',
    allowedConnections: ['rds', 'dynamodb', 's3', 'elasticache', 'sqs', 'sns', 'vpc', 'iam'],
    properties: [
      {
        name: 'clusterName',
        label: 'Cluster Name',
        type: 'text',
        default: 'my-cluster',
        required: true,
      },
      {
        name: 'serviceName',
        label: 'Service Name',
        type: 'text',
        default: 'my-service',
        required: true,
      },
      {
        name: 'launchType',
        label: 'Launch Type',
        type: 'select',
        default: 'FARGATE',
        options: [
          { value: 'FARGATE', label: 'Fargate (Serverless)' },
          { value: 'EC2', label: 'EC2' },
        ],
      },
      {
        name: 'cpu',
        label: 'CPU',
        type: 'select',
        default: '512',
        options: [
          { value: '256', label: '0.25 vCPU' },
          { value: '512', label: '0.5 vCPU' },
          { value: '1024', label: '1 vCPU' },
          { value: '2048', label: '2 vCPU' },
        ],
      },
      {
        name: 'memory',
        label: 'Memory',
        type: 'select',
        default: '1024',
        options: [
          { value: '512', label: '512 MB' },
          { value: '1024', label: '1 GB' },
          { value: '2048', label: '2 GB' },
          { value: '4096', label: '4 GB' },
        ],
      },
      { name: 'desiredCount', label: 'Desired Tasks', type: 'number', default: 2 },
      { name: 'containerPort', label: 'Container Port', type: 'number', default: 80 },
      { name: 'enableAutoScaling', label: 'Enable Auto Scaling', type: 'boolean', default: true },
    ],
    iac: {
      terraformResource: 'aws_ecs_service',
      pulumiClass: 'aws.ecs.Service',
      fromParent: [{ argument: 'cluster', from: 'cluster' }],
    },
    subnetPlacement: { allowedInPublic: true, allowedInPrivate: true, requiresSubnet: false },
  },

  // Storage
  {
    id: 's3',
    name: 'S3',
    shortName: 'S3',
    category: 'storage',
    description: 'Object storage service',
    color: '#569A31',
    icon: 'database',
    allowedConnections: ['cloudfront', 'lambda', 'iam'],
    properties: [
      {
        name: 'bucketName',
        label: 'Bucket Name',
        type: 'text',
        default: 'my-bucket',
        required: true,
      },
      { name: 'versioning', label: 'Versioning', type: 'boolean', default: false },
      {
        name: 'encryption',
        label: 'Encryption',
        type: 'select',
        default: 'AES256',
        options: [
          { value: 'AES256', label: 'SSE-S3 (AES-256)' },
          { value: 'aws:kms', label: 'SSE-KMS' },
          { value: 'none', label: 'None' },
        ],
      },
      { name: 'publicAccess', label: 'Block Public Access', type: 'boolean', default: true },
      { name: 'staticHosting', label: 'Static Website Hosting', type: 'boolean', default: false },
      { name: 'indexDocument', label: 'Index Document', type: 'text', default: 'index.html' },
      { name: 'enableCors', label: 'Enable CORS', type: 'boolean', default: false },
    ],
    iac: { terraformResource: 'aws_s3_bucket', pulumiClass: 'aws.s3.Bucket' },
  },

  // Database
  {
    id: 'rds',
    name: 'RDS',
    shortName: 'RDS',
    category: 'database',
    description: 'Managed relational database',
    color: '#4053D6',
    icon: 'database',
    allowedConnections: ['ec2', 'lambda', 'ecs', 'vpc'],
    properties: [
      {
        name: 'identifier',
        label: 'DB Identifier',
        type: 'text',
        default: 'my-database',
        required: true,
      },
      {
        name: 'engine',
        label: 'Database Engine',
        type: 'select',
        default: 'postgres',
        options: [
          { value: 'postgres', label: 'PostgreSQL 16' },
          { value: 'mysql', label: 'MySQL 8.0' },
          { value: 'mariadb', label: 'MariaDB 10.11' },
          { value: 'aurora-postgresql', label: 'Aurora PostgreSQL' },
        ],
      },
      {
        name: 'instanceClass',
        label: 'Instance Class',
        type: 'select',
        default: 'db.t3.micro',
        options: [
          { value: 'db.t3.micro', label: 'db.t3.micro (Free tier)' },
          { value: 'db.t3.small', label: 'db.t3.small (2 vCPU, 2GB)' },
          { value: 'db.t3.medium', label: 'db.t3.medium (2 vCPU, 4GB)' },
          { value: 'db.r5.large', label: 'db.r5.large (2 vCPU, 16GB)' },
        ],
      },
      { name: 'allocatedStorage', label: 'Storage (GB)', type: 'number', default: 20 },
      { name: 'multiAz', label: 'Multi-AZ Deployment', type: 'boolean', default: false },
      { name: 'publiclyAccessible', label: 'Publicly Accessible', type: 'boolean', default: false },
      { name: 'deletionProtection', label: 'Deletion Protection', type: 'boolean', default: true },
    ],
    iac: { terraformResource: 'aws_db_instance', pulumiClass: 'aws.rds.Instance' },
    subnetPlacement: { allowedInPublic: false, allowedInPrivate: true, requiresSubnet: false },
  },
  {
    id: 'dynamodb',
    name: 'DynamoDB',
    shortName: 'DDB',
    category: 'database',
    description: 'NoSQL database service',
    color: '#4053D6',
    icon: 'table',
    allowedConnections: ['lambda', 'ec2', 'ecs', 'iam'],
    properties: [
      { name: 'tableName', label: 'Table Name', type: 'text', default: 'my-table', required: true },
      {
        name: 'billingMode',
        label: 'Billing Mode',
        type: 'select',
        default: 'PAY_PER_REQUEST',
        options: [
          { value: 'PAY_PER_REQUEST', label: 'On-Demand' },
          { value: 'PROVISIONED', label: 'Provisioned' },
        ],
      },
      { name: 'hashKey', label: 'Partition Key', type: 'text', default: 'id', required: true },
      {
        name: 'hashKeyType',
        label: 'Partition Key Type',
        type: 'select',
        default: 'S',
        options: [
          { value: 'S', label: 'String' },
          { value: 'N', label: 'Number' },
        ],
      },
      { name: 'rangeKey', label: 'Sort Key (optional)', type: 'text', default: '' },
      { name: 'enableStreams', label: 'Enable Streams', type: 'boolean', default: false },
      {
        name: 'pointInTimeRecovery',
        label: 'Point-in-Time Recovery',
        type: 'boolean',
        default: false,
      },
    ],
    iac: { terraformResource: 'aws_dynamodb_table', pulumiClass: 'aws.dynamodb.Table' },
  },
  {
    id: 'elasticache',
    name: 'ElastiCache',
    shortName: 'Cache',
    category: 'database',
    description: 'In-memory caching service',
    color: '#4053D6',
    icon: 'zap',
    allowedConnections: ['ec2', 'lambda', 'ecs', 'vpc'],
    properties: [
      { name: 'clusterId', label: 'Cluster ID', type: 'text', default: 'my-cache', required: true },
      {
        name: 'engine',
        label: 'Engine',
        type: 'select',
        default: 'redis',
        options: [
          { value: 'redis', label: 'Redis 7.x' },
          { value: 'memcached', label: 'Memcached 1.6' },
        ],
      },
      {
        name: 'nodeType',
        label: 'Node Type',
        type: 'select',
        default: 'cache.t3.micro',
        options: [
          { value: 'cache.t3.micro', label: 'cache.t3.micro (0.5GB)' },
          { value: 'cache.t3.small', label: 'cache.t3.small (1.5GB)' },
          { value: 'cache.r5.large', label: 'cache.r5.large (13GB)' },
        ],
      },
      { name: 'numCacheNodes', label: 'Number of Nodes', type: 'number', default: 1 },
      { name: 'port', label: 'Port', type: 'number', default: 6379 },
    ],
    iac: { terraformResource: 'aws_elasticache_cluster', pulumiClass: 'aws.elasticache.Cluster' },
    subnetPlacement: { allowedInPublic: false, allowedInPrivate: true, requiresSubnet: false },
  },

  // Networking
  {
    id: 'cloudfront',
    name: 'CloudFront',
    shortName: 'CF',
    category: 'networking',
    description: 'Content delivery network',
    color: '#8C4FFF',
    icon: 'globe',
    allowedConnections: ['s3', 'api-gateway', 'ec2', 'lambda', 'route53', 'alb', 'nlb'],
    properties: [
      { name: 'comment', label: 'Distribution Name', type: 'text', default: 'My Distribution' },
      {
        name: 'priceClass',
        label: 'Price Class',
        type: 'select',
        default: 'PriceClass_100',
        options: [
          { value: 'PriceClass_100', label: 'North America & Europe' },
          { value: 'PriceClass_200', label: 'NA, EU, Asia, Middle East, Africa' },
          { value: 'PriceClass_All', label: 'All Edge Locations (Global)' },
        ],
      },
      {
        name: 'defaultRootObject',
        label: 'Default Root Object',
        type: 'text',
        default: 'index.html',
      },
      { name: 'defaultTtl', label: 'Default TTL (seconds)', type: 'number', default: 86400 },
      {
        name: 'viewerProtocol',
        label: 'Viewer Protocol Policy',
        type: 'select',
        default: 'redirect-to-https',
        options: [
          { value: 'redirect-to-https', label: 'Redirect HTTP to HTTPS' },
          { value: 'https-only', label: 'HTTPS Only' },
        ],
      },
      { name: 'enableCompression', label: 'Enable Compression', type: 'boolean', default: true },
    ],
    iac: {
      terraformResource: 'aws_cloudfront_distribution',
      pulumiClass: 'aws.cloudfront.Distribution',
    },
  },
  {
    id: 'route53',
    name: 'Route 53',
    shortName: 'R53',
    category: 'networking',
    description: 'DNS and domain management',
    color: '#8C4FFF',
    icon: 'globe',
    allowedConnections: ['cloudfront', 'api-gateway', 'ec2', 's3'],
    properties: [
      {
        name: 'domainName',
        label: 'Domain Name',
        type: 'text',
        default: 'example.com',
        required: true,
      },
      {
        name: 'zoneType',
        label: 'Zone Type',
        type: 'select',
        default: 'public',
        options: [
          { value: 'public', label: 'Public Hosted Zone' },
          { value: 'private', label: 'Private Hosted Zone' },
        ],
      },
    ],
    iac: { terraformResource: 'aws_route53_zone', pulumiClass: 'aws.route53.Zone' },
  },
  {
    id: 'vpc',
    name: 'VPC',
    shortName: 'VPC',
    category: 'networking',
    description: 'Virtual private cloud',
    color: '#8C4FFF',
    icon: 'network',
    allowedConnections: ['ec2', 'rds', 'ecs', 'lambda', 'elasticache'],
    properties: [
      { name: 'vpcName', label: 'VPC Name', type: 'text', default: 'my-vpc', required: true },
      {
        name: 'cidrBlock',
        label: 'CIDR Block',
        type: 'text',
        default: '10.0.0.0/16',
        required: true,
      },
      { name: 'enableDnsHostnames', label: 'DNS Hostnames', type: 'boolean', default: true },
      { name: 'enableDnsSupport', label: 'DNS Support', type: 'boolean', default: true },
      { name: 'publicSubnets', label: 'Public Subnets', type: 'number', default: 2 },
      { name: 'privateSubnets', label: 'Private Subnets', type: 'number', default: 2 },
      { name: 'enableNatGateway', label: 'NAT Gateway', type: 'boolean', default: true },
    ],
    iac: { terraformResource: 'aws_vpc', pulumiClass: 'aws.ec2.Vpc' },
  },
  {
    id: 'api-gateway',
    name: 'API Gateway',
    shortName: 'API',
    category: 'networking',
    description: 'API management service',
    color: '#FF4F8B',
    icon: 'git-branch',
    allowedConnections: ['lambda', 'ec2', 'ecs', 'cognito'],
    properties: [
      { name: 'apiName', label: 'API Name', type: 'text', default: 'my-api', required: true },
      {
        name: 'apiType',
        label: 'API Type',
        type: 'select',
        default: 'HTTP',
        options: [
          { value: 'HTTP', label: 'HTTP API (Recommended)' },
          { value: 'REST', label: 'REST API' },
          { value: 'WEBSOCKET', label: 'WebSocket API' },
        ],
      },
      { name: 'stageName', label: 'Stage Name', type: 'text', default: 'prod' },
      { name: 'corsEnabled', label: 'Enable CORS', type: 'boolean', default: true },
      { name: 'corsOrigins', label: 'CORS Origins', type: 'text', default: '*' },
      { name: 'enableAccessLogs', label: 'Enable Access Logs', type: 'boolean', default: false },
    ],
    iac: { terraformResource: 'aws_apigatewayv2_api', pulumiClass: 'aws.apigatewayv2.Api' },
  },

  // Security
  {
    id: 'iam',
    name: 'IAM Role',
    shortName: 'IAM',
    category: 'security',
    description: 'Identity and access management',
    color: '#DD344C',
    icon: 'shield',
    allowedConnections: ['lambda', 'ec2', 'ecs', 's3', 'dynamodb'],
    properties: [
      { name: 'roleName', label: 'Role Name', type: 'text', default: 'my-role', required: true },
      { name: 'description', label: 'Description', type: 'text', default: '' },
      {
        name: 'assumeRoleService',
        label: 'Trusted Service',
        type: 'select',
        default: 'lambda.amazonaws.com',
        options: [
          { value: 'lambda.amazonaws.com', label: 'Lambda' },
          { value: 'ec2.amazonaws.com', label: 'EC2' },
          { value: 'ecs-tasks.amazonaws.com', label: 'ECS Tasks' },
        ],
      },
      {
        name: 'managedPolicies',
        label: 'Managed Policies',
        type: 'textarea',
        default: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      },
    ],
    iac: { terraformResource: 'aws_iam_role', pulumiClass: 'aws.iam.Role' },
  },
  {
    id: 'cognito',
    name: 'Cognito',
    shortName: 'Cog',
    category: 'security',
    description: 'User authentication service',
    color: '#DD344C',
    icon: 'users',
    allowedConnections: ['api-gateway', 'lambda'],
    properties: [
      {
        name: 'poolName',
        label: 'User Pool Name',
        type: 'text',
        default: 'my-user-pool',
        required: true,
      },
      {
        name: 'mfaConfiguration',
        label: 'MFA',
        type: 'select',
        default: 'OPTIONAL',
        options: [
          { value: 'OFF', label: 'Off' },
          { value: 'OPTIONAL', label: 'Optional' },
          { value: 'ON', label: 'Required' },
        ],
      },
      {
        name: 'usernameAttributes',
        label: 'Sign-in Method',
        type: 'select',
        default: 'email',
        options: [
          { value: 'email', label: 'Email' },
          { value: 'phone_number', label: 'Phone Number' },
        ],
      },
      { name: 'passwordMinLength', label: 'Min Password Length', type: 'number', default: 8 },
    ],
    iac: { terraformResource: 'aws_cognito_user_pool', pulumiClass: 'aws.cognito.UserPool' },
  },

  // Integration
  {
    id: 'sns',
    name: 'SNS',
    shortName: 'SNS',
    category: 'integration',
    description: 'Pub/sub messaging service',
    color: '#FF4F8B',
    icon: 'bell',
    allowedConnections: ['lambda', 'sqs'],
    properties: [
      { name: 'topicName', label: 'Topic Name', type: 'text', default: 'my-topic', required: true },
      { name: 'displayName', label: 'Display Name', type: 'text', default: '' },
      { name: 'fifoTopic', label: 'FIFO Topic', type: 'boolean', default: false },
    ],
    iac: { terraformResource: 'aws_sns_topic', pulumiClass: 'aws.sns.Topic' },
  },
  {
    id: 'sqs',
    name: 'SQS',
    shortName: 'SQS',
    category: 'integration',
    description: 'Message queue service',
    color: '#FF4F8B',
    icon: 'inbox',
    allowedConnections: ['lambda', 'ec2', 'ecs', 'sns'],
    properties: [
      { name: 'queueName', label: 'Queue Name', type: 'text', default: 'my-queue', required: true },
      { name: 'fifoQueue', label: 'FIFO Queue', type: 'boolean', default: false },
      {
        name: 'visibilityTimeout',
        label: 'Visibility Timeout (seconds)',
        type: 'number',
        default: 30,
      },
      {
        name: 'messageRetention',
        label: 'Message Retention (seconds)',
        type: 'number',
        default: 345600,
      },
      { name: 'enableDlq', label: 'Enable Dead Letter Queue', type: 'boolean', default: false },
      { name: 'enableEncryption', label: 'Enable Encryption', type: 'boolean', default: true },
    ],
    iac: { terraformResource: 'aws_sqs_queue', pulumiClass: 'aws.sqs.Queue' },
  },

  // VPC Environment Components
  {
    id: 'vpc-environment',
    name: 'VPC Environment',
    shortName: 'VPC',
    category: 'networking',
    description: 'Virtual network container with public and private subnets',
    color: '#8C4FFF',
    icon: 'network',
    allowedConnections: [],
    isContainer: true,
    properties: [
      { name: 'vpcName', label: 'VPC Name', type: 'text', default: 'my-vpc', required: true },
      {
        name: 'cidrBlock',
        label: 'CIDR Block',
        type: 'text',
        default: '10.0.0.0/16',
        required: true,
      },
      { name: 'enableDnsHostnames', label: 'DNS Hostnames', type: 'boolean', default: true },
      { name: 'enableDnsSupport', label: 'DNS Support', type: 'boolean', default: true },
    ],
    iac: { terraformResource: 'aws_vpc', pulumiClass: 'aws.ec2.Vpc' },
  },
  {
    id: 'public-subnet',
    name: 'Public Subnet',
    shortName: 'Pub',
    category: 'networking',
    description: 'Internet-accessible subnet with public IP assignment',
    color: '#22C55E',
    icon: 'globe',
    allowedConnections: [],
    isContainer: true,
    parentRequired: 'vpc-environment',
    properties: [
      {
        name: 'subnetName',
        label: 'Subnet Name',
        type: 'text',
        default: 'public-subnet',
        required: true,
      },
      { name: 'cidrBlock', label: 'CIDR Block', type: 'text', default: '10.0.1.0/24' },
      {
        name: 'availabilityZone',
        label: 'Availability Zone',
        type: 'select',
        default: 'us-east-1a',
        options: [
          { value: 'us-east-1a', label: 'us-east-1a' },
          { value: 'us-east-1b', label: 'us-east-1b' },
          { value: 'us-west-2a', label: 'us-west-2a' },
          { value: 'us-west-2b', label: 'us-west-2b' },
        ],
      },
    ],
    iac: {
      terraformResource: 'aws_subnet',
      pulumiClass: 'aws.ec2.Subnet',
      fromParent: [{ argument: 'vpcId', from: 'vpc' }],
    },
  },
  {
    id: 'private-subnet',
    name: 'Private Subnet',
    shortName: 'Priv',
    category: 'networking',
    description: 'Internal-only subnet without public IP assignment',
    color: '#EF4444',
    icon: 'shield',
    allowedConnections: [],
    isContainer: true,
    parentRequired: 'vpc-environment',
    properties: [
      {
        name: 'subnetName',
        label: 'Subnet Name',
        type: 'text',
        default: 'private-subnet',
        required: true,
      },
      { name: 'cidrBlock', label: 'CIDR Block', type: 'text', default: '10.0.10.0/24' },
      {
        name: 'availabilityZone',
        label: 'Availability Zone',
        type: 'select',
        default: 'us-east-1a',
        options: [
          { value: 'us-east-1a', label: 'us-east-1a' },
          { value: 'us-east-1b', label: 'us-east-1b' },
          { value: 'us-west-2a', label: 'us-west-2a' },
          { value: 'us-west-2b', label: 'us-west-2b' },
        ],
      },
    ],
    iac: {
      terraformResource: 'aws_subnet',
      pulumiClass: 'aws.ec2.Subnet',
      fromParent: [{ argument: 'vpcId', from: 'vpc' }],
    },
  },
  {
    id: 'alb',
    name: 'Application Load Balancer',
    shortName: 'ALB',
    category: 'networking',
    description: 'Layer 7 load balancer for HTTP/HTTPS traffic',
    color: '#8C4FFF',
    icon: 'git-branch',
    allowedConnections: ['ecs', 'ec2', 'lambda'],
    subnetPlacement: { allowedInPublic: true, allowedInPrivate: false, requiresSubnet: true },
    properties: [
      { name: 'albName', label: 'ALB Name', type: 'text', default: 'my-alb', required: true },
      { name: 'internal', label: 'Internal', type: 'boolean', default: false },
      { name: 'idleTimeout', label: 'Idle Timeout (seconds)', type: 'number', default: 60 },
      { name: 'enableHttp2', label: 'Enable HTTP/2', type: 'boolean', default: true },
      { name: 'listenerPort', label: 'Listener Port', type: 'number', default: 80 },
      { name: 'healthCheckPath', label: 'Health Check Path', type: 'text', default: '/' },
    ],
    iac: { terraformResource: 'aws_lb', pulumiClass: 'aws.lb.LoadBalancer' },
  },
  {
    id: 'nlb',
    name: 'Network Load Balancer',
    shortName: 'NLB',
    category: 'networking',
    description: 'Layer 4 load balancer for TCP/UDP traffic',
    color: '#8C4FFF',
    icon: 'git-branch',
    allowedConnections: ['ecs', 'ec2'],
    subnetPlacement: { allowedInPublic: true, allowedInPrivate: true, requiresSubnet: true },
    properties: [
      { name: 'nlbName', label: 'NLB Name', type: 'text', default: 'my-nlb', required: true },
      { name: 'internal', label: 'Internal', type: 'boolean', default: false },
      {
        name: 'enableCrossZone',
        label: 'Cross-Zone Load Balancing',
        type: 'boolean',
        default: true,
      },
      { name: 'listenerPort', label: 'Listener Port', type: 'number', default: 80 },
    ],
    iac: { terraformResource: 'aws_lb', pulumiClass: 'aws.lb.LoadBalancer' },
  },
  {
    id: 'nat-gateway',
    name: 'NAT Gateway',
    shortName: 'NAT',
    category: 'networking',
    description: 'Network address translation for private subnet internet access',
    color: '#8C4FFF',
    icon: 'arrow-right-left',
    allowedConnections: [],
    subnetPlacement: { allowedInPublic: true, allowedInPrivate: false, requiresSubnet: true },
    properties: [
      { name: 'natName', label: 'NAT Name', type: 'text', default: 'my-nat', required: true },
      {
        name: 'connectivityType',
        label: 'Connectivity Type',
        type: 'select',
        default: 'public',
        options: [
          { value: 'public', label: 'Public (requires EIP)' },
          { value: 'private', label: 'Private' },
        ],
      },
    ],
    iac: {
      terraformResource: 'aws_nat_gateway',
      pulumiClass: 'aws.ec2.NatGateway',
      fromParent: [{ argument: 'subnetId', from: 'subnet' }],
    },
  },
];

export const awsServices: AWSService[] = [
  ...coreServices,
  ...dataServices,
  ...aiServices,
  ...integrationServices,
  ...platformServices,
];

export function getServiceById(id: string): AWSService | undefined {
  return awsServices.find((s) => s.id === id);
}

export function getServicesByCategory(category: string): AWSService[] {
  return awsServices.filter((s) => s.category === category);
}

export function canConnect(sourceId: string, targetId: string): boolean {
  const source = getServiceById(sourceId);
  const target = getServiceById(targetId);
  if (!source || !target) return false;

  return (
    source.allowedConnections.includes(targetId) || target.allowedConnections.includes(sourceId)
  );
}
