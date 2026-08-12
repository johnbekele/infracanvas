/**
 * Compute, containers, security, and observability.
 *
 * The container entries matter more than they look. A cluster is a box that
 * holds services, an availability zone is the box everything else sits in, and
 * without them a diagram of nine services is nine boxes in a row with no
 * statement about what shares capacity or what survives losing a zone.
 */
import type { AWSService } from '../aws-services';
import { bool, num, select, text } from './props';

const COMPUTE_COLOUR = '#FF9900';
const SECURITY_COLOUR = '#DD344C';
const NETWORK_COLOUR = '#8C4FFF';
const OBSERVABILITY_COLOUR = '#E7157B';

const anySubnet = {
  allowedInPublic: true,
  allowedInPrivate: true,
  requiresSubnet: false,
} as const;

export const platformServices: AWSService[] = [
  // --- Containers that hold other nodes ---------------------------------------
  {
    id: 'ecs-cluster',
    name: 'ECS Cluster',
    shortName: 'Cluster',
    category: 'compute',
    description: 'Capacity and namespace shared by container services',
    color: COMPUTE_COLOUR,
    icon: 'boxes',
    allowedConnections: [],
    isContainer: true,
    // Not the zone itself: the zone now holds the network, so a cluster placed
    // straight into one would be a cluster in no subnet, which cannot be emitted.
    allowedParents: ['private-subnet', 'public-subnet'],
    subnetPlacement: anySubnet,
    properties: [
      text('clusterName', 'Cluster Name', 'my-cluster', true),
      select('capacityProvider', 'Capacity', [
        ['FARGATE', 'Fargate'],
        ['FARGATE_SPOT', 'Fargate Spot'],
        ['EC2', 'EC2 instances'],
      ]),
      bool('containerInsights', 'Container Insights', true),
    ],
    iac: {
      terraformResource: 'aws_ecs_cluster',
      pulumiClass: 'aws.ecs.Cluster',
      overrides: { capacityProvider: null, containerInsights: null },
    },
  },
  {
    id: 'eks-cluster',
    name: 'EKS Cluster',
    shortName: 'EKS',
    category: 'compute',
    description: 'Managed Kubernetes control plane and its workloads',
    color: COMPUTE_COLOUR,
    icon: 'hexagon',
    allowedConnections: ['rds', 'elasticache', 's3', 'efs', 'msk'],
    isContainer: true,
    allowedParents: ['private-subnet'],
    subnetPlacement: anySubnet,
    properties: [
      text('clusterName', 'Cluster Name', 'my-eks', true),
      text('version', 'Kubernetes Version', '1.31'),
      select('nodeType', 'Node Group Type', [
        ['fargate', 'Fargate profiles'],
        ['managed', 'Managed node group'],
      ]),
      select('instanceType', 'Node Instance Type', ['t3.medium', 'm6i.large', 'c6i.large']),
      num('desiredNodes', 'Desired Nodes', 2),
    ],
    iac: {
      terraformResource: 'aws_eks_cluster',
      pulumiClass: 'aws.eks.Cluster',
      overrides: { nodeType: null, instanceType: null, desiredNodes: null },
    },
  },
  {
    id: 'availability-zone',
    name: 'Availability Zone',
    shortName: 'AZ',
    category: 'networking',
    description: 'Isolated failure domain holding a network',
    color: NETWORK_COLOUR,
    icon: 'layout-grid',
    allowedConnections: [],
    isContainer: true,
    // The outermost box on the canvas: a zone is where the racks are, and the
    // networks drawn inside it are what happens to be running there. Declaring
    // no parents is what keeps it out of a VPC.
    properties: [
      text('zoneName', 'Zone', 'us-east-1a', true),
      bool('primary', 'Primary Zone', true),
    ],
    // A zone is a placement constraint rather than a resource: it becomes the
    // `availability_zone` argument on the subnets drawn anywhere inside it.
    iac: {
      terraformResource: '',
      pulumiClass: '',
      overrides: { zoneName: null, primary: null },
    },
  },

  // --- Compute ----------------------------------------------------------------
  {
    id: 'fargate',
    name: 'Fargate Service',
    shortName: 'Fargate',
    category: 'compute',
    description: 'Container service with no instances to manage',
    color: COMPUTE_COLOUR,
    icon: 'container',
    allowedConnections: ['rds', 'elasticache', 's3', 'sqs', 'efs', 'secrets-manager'],
    allowedParents: ['ecs-cluster', 'private-subnet', 'public-subnet'],
    subnetPlacement: anySubnet,
    properties: [
      text('serviceName', 'Service Name', 'my-service', true),
      select('cpu', 'CPU', [
        ['256', '0.25 vCPU'],
        ['512', '0.5 vCPU'],
        ['1024', '1 vCPU'],
        ['2048', '2 vCPU'],
        ['4096', '4 vCPU'],
      ]),
      select('memory', 'Memory', [
        ['512', '0.5 GB'],
        ['1024', '1 GB'],
        ['2048', '2 GB'],
        ['4096', '4 GB'],
        ['8192', '8 GB'],
      ]),
      num('desiredCount', 'Desired Tasks', 2),
      num('containerPort', 'Container Port', 8080),
      bool('spot', 'Use Fargate Spot', false),
    ],
    iac: {
      terraformResource: 'aws_ecs_service',
      pulumiClass: 'aws.ecs.Service',
      fromParent: [{ argument: 'cluster', from: 'cluster' }],
    },
  },
  {
    id: 'app-runner',
    name: 'App Runner',
    shortName: 'Runner',
    category: 'compute',
    description: 'Container service with load balancing and scaling built in',
    color: COMPUTE_COLOUR,
    icon: 'rocket',
    allowedConnections: ['rds', 's3', 'secrets-manager'],
    properties: [
      text('serviceName', 'Service Name', 'my-app', true),
      select('cpu', 'CPU', ['0.25 vCPU', '0.5 vCPU', '1 vCPU', '2 vCPU']),
      select('memory', 'Memory', ['0.5 GB', '1 GB', '2 GB', '4 GB']),
      num('port', 'Port', 8080),
      num('maxConcurrency', 'Requests per Instance', 100),
      bool('autoDeploy', 'Deploy on Image Push', true),
    ],
    iac: { terraformResource: 'aws_apprunner_service', pulumiClass: 'aws.apprunner.Service' },
  },
  {
    id: 'batch',
    name: 'AWS Batch',
    shortName: 'Batch',
    category: 'compute',
    description: 'Queued batch jobs on managed capacity',
    color: COMPUTE_COLOUR,
    icon: 'list-checks',
    allowedConnections: ['s3', 'efs', 'ecr', 'sqs', 'step-functions'],
    properties: [
      text('computeEnvironmentName', 'Compute Environment', 'my-batch', true),
      select('computeType', 'Compute Type', ['FARGATE', 'FARGATE_SPOT', 'EC2', 'SPOT']),
      num('maxVcpus', 'Max vCPUs', 16),
      bool('gpuEnabled', 'GPU Instances', false),
    ],
    iac: {
      terraformResource: 'aws_batch_compute_environment',
      pulumiClass: 'aws.batch.ComputeEnvironment',
      overrides: { gpuEnabled: null },
    },
  },
  {
    id: 'ecr',
    name: 'ECR',
    shortName: 'ECR',
    category: 'storage',
    description: 'Private container image registry',
    color: '#569A31',
    icon: 'package',
    allowedConnections: ['ecs', 'eks-cluster', 'fargate', 'batch', 'app-runner', 'lambda'],
    properties: [
      text('repositoryName', 'Repository Name', 'my-app', true),
      select('imageTagMutability', 'Tag Mutability', ['MUTABLE', 'IMMUTABLE']),
      bool('scanOnPush', 'Scan Images on Push', true),
      num('retainImageCount', 'Images to Retain', 20),
    ],
    iac: {
      terraformResource: 'aws_ecr_repository',
      pulumiClass: 'aws.ecr.Repository',
      overrides: { retainImageCount: null },
    },
  },
  {
    id: 'amplify',
    name: 'Amplify Hosting',
    shortName: 'Amplify',
    category: 'compute',
    description: 'Build and host a front end from a repository',
    color: COMPUTE_COLOUR,
    icon: 'globe',
    allowedConnections: ['api-gateway', 'appsync', 'cognito', 's3'],
    properties: [
      text('appName', 'App Name', 'my-site', true),
      text('branch', 'Branch', 'main'),
      select('framework', 'Framework', ['Next.js', 'React', 'Vue', 'Astro', 'SvelteKit']),
      bool('serverSideRendering', 'Server-Side Rendering', false),
    ],
    iac: {
      terraformResource: 'aws_amplify_app',
      pulumiClass: 'aws.amplify.App',
      overrides: { branch: null, serverSideRendering: null },
    },
  },

  // --- Security ---------------------------------------------------------------
  {
    id: 'secrets-manager',
    name: 'Secrets Manager',
    shortName: 'Secrets',
    category: 'security',
    description: 'Encrypted secrets with rotation',
    color: SECURITY_COLOUR,
    icon: 'key-round',
    allowedConnections: ['ecs', 'ec2', 'lambda', 'rds', 'fargate', 'eks-cluster'],
    properties: [
      text('secretName', 'Secret Name', 'my-app/credentials', true),
      num('recoveryWindowDays', 'Recovery Window (days)', 7),
      bool('rotationEnabled', 'Automatic Rotation', false),
      num('rotationDays', 'Rotation Interval (days)', 30),
    ],
    iac: {
      terraformResource: 'aws_secretsmanager_secret',
      pulumiClass: 'aws.secretsmanager.Secret',
    },
  },
  {
    id: 'kms',
    name: 'KMS',
    shortName: 'KMS',
    category: 'security',
    description: 'Customer-managed encryption keys',
    color: SECURITY_COLOUR,
    icon: 'lock',
    allowedConnections: ['s3', 'rds', 'secrets-manager', 'efs', 'dynamodb'],
    properties: [
      text('alias', 'Key Alias', 'alias/my-app', true),
      select('keyUsage', 'Usage', ['ENCRYPT_DECRYPT', 'SIGN_VERIFY']),
      bool('enableKeyRotation', 'Annual Rotation', true),
      num('deletionWindowInDays', 'Deletion Window (days)', 30),
    ],
    iac: { terraformResource: 'aws_kms_key', pulumiClass: 'aws.kms.Key' },
  },
  {
    id: 'waf',
    name: 'WAF',
    shortName: 'WAF',
    category: 'security',
    description: 'Request filtering in front of an entry point',
    color: SECURITY_COLOUR,
    icon: 'shield-check',
    allowedConnections: ['cloudfront', 'alb', 'api-gateway', 'appsync'],
    properties: [
      text('webAclName', 'Web ACL Name', 'my-waf', true),
      select('scope', 'Scope', [
        ['REGIONAL', 'Regional (ALB, API Gateway)'],
        ['CLOUDFRONT', 'CloudFront'],
      ]),
      bool('managedRulesEnabled', 'AWS Managed Rules', true),
      num('rateLimitPerFiveMinutes', 'Rate Limit per IP (5 min)', 2000),
    ],
    iac: {
      terraformResource: 'aws_wafv2_web_acl',
      pulumiClass: 'aws.wafv2.WebAcl',
      overrides: { managedRulesEnabled: null, rateLimitPerFiveMinutes: null },
    },
  },
  {
    id: 'acm',
    name: 'Certificate Manager',
    shortName: 'ACM',
    category: 'security',
    description: 'TLS certificates for load balancers and CDNs',
    color: SECURITY_COLOUR,
    icon: 'badge-check',
    allowedConnections: ['cloudfront', 'alb', 'nlb', 'api-gateway'],
    properties: [
      text('domainName', 'Domain Name', 'example.com', true),
      select('validationMethod', 'Validation', ['DNS', 'EMAIL']),
      text('subjectAlternativeNames', 'Additional Domains', '*.example.com'),
    ],
    iac: { terraformResource: 'aws_acm_certificate', pulumiClass: 'aws.acm.Certificate' },
  },
  {
    id: 'security-group',
    name: 'Security Group',
    shortName: 'SG',
    category: 'security',
    description: 'Stateful firewall rules for a resource',
    color: SECURITY_COLOUR,
    icon: 'shield',
    allowedConnections: ['ec2', 'ecs', 'rds', 'alb', 'elasticache', 'fargate'],
    allowedParents: ['vpc-environment'],
    properties: [
      text('groupName', 'Group Name', 'my-sg', true),
      text('ingressPorts', 'Allowed Inbound Ports', '443'),
      text('ingressCidr', 'Allowed Inbound CIDR', '0.0.0.0/0'),
      bool('allowAllEgress', 'Allow All Outbound', true),
    ],
    iac: {
      terraformResource: 'aws_security_group',
      pulumiClass: 'aws.ec2.SecurityGroup',
      fromParent: [{ argument: 'vpcId', from: 'vpc' }],
      overrides: { ingressPorts: null, ingressCidr: null, allowAllEgress: null },
    },
  },

  // --- Networking -------------------------------------------------------------
  {
    id: 'vpc-endpoint',
    name: 'VPC Endpoint',
    shortName: 'Endpoint',
    category: 'networking',
    description: 'Private route to an AWS service without a NAT gateway',
    color: NETWORK_COLOUR,
    icon: 'plug',
    allowedConnections: ['s3', 'dynamodb', 'secrets-manager', 'ecr', 'bedrock'],
    allowedParents: ['private-subnet', 'vpc-environment'],
    properties: [
      select('serviceName', 'Service', [
        'com.amazonaws.region.s3',
        'com.amazonaws.region.dynamodb',
        'com.amazonaws.region.secretsmanager',
        'com.amazonaws.region.ecr.dkr',
        'com.amazonaws.region.bedrock-runtime',
      ]),
      select('vpcEndpointType', 'Type', ['Gateway', 'Interface']),
      bool('privateDnsEnabled', 'Enable Private DNS', true),
    ],
    iac: {
      terraformResource: 'aws_vpc_endpoint',
      pulumiClass: 'aws.ec2.VpcEndpoint',
      fromParent: [{ argument: 'vpcId', from: 'vpc' }],
    },
  },

  // --- Observability ----------------------------------------------------------
  {
    id: 'cloudwatch',
    name: 'CloudWatch',
    shortName: 'CW',
    category: 'observability',
    description: 'Logs, metrics, and alarms',
    color: OBSERVABILITY_COLOUR,
    icon: 'activity',
    allowedConnections: ['ecs', 'ec2', 'lambda', 'rds', 'alb', 'sns'],
    properties: [
      text('logGroupName', 'Log Group', '/aws/my-app', true),
      num('retentionInDays', 'Log Retention (days)', 30),
      bool('metricsEnabled', 'Custom Metrics', true),
      num('expectedIngestGbPerMonth', 'Expected Log Volume (GB/month)', 10),
    ],
    iac: {
      terraformResource: 'aws_cloudwatch_log_group',
      pulumiClass: 'aws.cloudwatch.LogGroup',
      overrides: { metricsEnabled: null, expectedIngestGbPerMonth: null },
    },
  },
  {
    id: 'x-ray',
    name: 'X-Ray',
    shortName: 'X-Ray',
    category: 'observability',
    description: 'Distributed traces across services',
    color: OBSERVABILITY_COLOUR,
    icon: 'git-compare',
    allowedConnections: ['ecs', 'lambda', 'api-gateway', 'appsync', 'ec2'],
    properties: [
      text('groupName', 'Group Name', 'my-app-traces', true),
      num('samplingRate', 'Sampling Rate (%)', 5),
      num('expectedTracesPerMonth', 'Expected Traces per Month', 1000000),
    ],
    iac: {
      terraformResource: 'aws_xray_group',
      pulumiClass: 'aws.xray.Group',
      overrides: { samplingRate: null, expectedTracesPerMonth: null },
    },
  },
];
