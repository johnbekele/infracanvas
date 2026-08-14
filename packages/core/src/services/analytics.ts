/**
 * Warehouses, catalogs, and the jobs that move data between them.
 *
 * Analytics lived in `data-stores.ts` while it was three entries, on the grounds
 * that a warehouse is a database. Most of what AWS files under Analytics is not
 * a store at all -- a crawler, a permissions boundary, a subscription to someone
 * else's data -- so they have their own module rather than accumulating in one
 * that says databases on the tin.
 *
 * Three marks on the AWS Analytics sheet have no entry here. QuickSight and Data
 * Pipeline were dropped from the icon package, Glue Elastic Views went with the
 * service AWS discontinued, and Glue DataBrew has no resource in the standard
 * Terraform provider. A palette entry that exports nothing is worse than an
 * absent one, because it promises code the exporter cannot write.
 */
import type { AWSService } from '../aws-services';
import { bool, num, select, text } from './props';

const ANALYTICS_COLOUR = '#8C4FFF';

/** Sits in a private subnet and is reached from inside the VPC only. */
const privateOnly = {
  allowedInPublic: false,
  allowedInPrivate: true,
  requiresSubnet: true,
} as const;

export const analyticsServices: AWSService[] = [
  {
    id: 'redshift',
    name: 'Redshift',
    shortName: 'Redshift',
    category: 'analytics',
    description: 'Columnar data warehouse',
    color: ANALYTICS_COLOUR,
    icon: 'redshift',
    allowedConnections: ['s3', 'glue', 'athena', 'ecs', 'lambda'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('namespaceName', 'Namespace', 'my-warehouse', true),
      select('deployment', 'Deployment', [
        ['serverless', 'Serverless'],
        ['provisioned', 'Provisioned cluster'],
      ]),
      num('baseCapacityRpu', 'Base Capacity (RPU)', 8),
      select('nodeType', 'Node Type', ['ra3.large', 'ra3.xlplus', 'ra3.4xlarge']),
      num('nodeCount', 'Nodes', 2),
    ],
    iac: {
      terraformResource: 'aws_redshiftserverless_namespace',
      pulumiClass: 'aws.redshiftserverless.Namespace',
      overrides: { deployment: null, nodeType: null, nodeCount: null },
    },
  },
  {
    id: 'athena',
    name: 'Athena',
    shortName: 'Athena',
    category: 'analytics',
    description: 'SQL over files in S3',
    color: ANALYTICS_COLOUR,
    icon: 'athena',
    allowedConnections: ['s3', 'glue', 'lambda', 'ecs'],
    properties: [
      text('workgroupName', 'Workgroup', 'primary', true),
      select('engineVersion', 'Engine', ['Athena engine version 3', 'Athena engine version 2']),
      num('bytesScannedCutoffPerQuery', 'Per-Query Scan Limit (GB)', 100),
    ],
    iac: { terraformResource: 'aws_athena_workgroup', pulumiClass: 'aws.athena.Workgroup' },
  },
  {
    id: 'glue',
    name: 'Glue',
    shortName: 'Glue',
    category: 'analytics',
    description: 'Catalog and serverless ETL jobs',
    color: ANALYTICS_COLOUR,
    icon: 'glue',
    allowedConnections: ['s3', 'redshift', 'athena', 'rds', 'glue-crawler'],
    properties: [
      text('jobName', 'Job Name', 'my-etl-job', true),
      select('workerType', 'Worker Type', ['G.1X', 'G.2X', 'G.4X', 'G.025X']),
      num('numberOfWorkers', 'Workers', 2),
      select('glueVersion', 'Glue Version', ['4.0', '3.0']),
    ],
    iac: { terraformResource: 'aws_glue_job', pulumiClass: 'aws.glue.Job' },
  },
  {
    id: 'glue-crawler',
    name: 'Glue Crawler',
    shortName: 'Crawler',
    category: 'analytics',
    description: 'Infers schemas and populates the Glue catalog',
    color: ANALYTICS_COLOUR,
    icon: 'glue-crawler',
    allowedConnections: ['s3', 'glue', 'rds', 'redshift'],
    properties: [
      // `name`, not `crawlerName`: argument names are derived from property
      // names, and the provider calls this one `name`.
      text('name', 'Crawler Name', 'my-crawler', true),
      text('databaseName', 'Catalog Database', 'my-database', true),
      text('schedule', 'Schedule', 'cron(0 1 * * ? *)'),
      text('tablePrefix', 'Table Prefix', ''),
    ],
    iac: { terraformResource: 'aws_glue_crawler', pulumiClass: 'aws.glue.Crawler' },
  },
  {
    id: 'emr',
    name: 'EMR',
    shortName: 'EMR',
    category: 'analytics',
    description: 'Managed Spark, Hive, and Presto clusters',
    color: ANALYTICS_COLOUR,
    icon: 'emr',
    allowedConnections: ['s3', 'glue', 'redshift', 'athena', 'lake-formation'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('name', 'Cluster Name', 'my-cluster', true),
      select('releaseLabel', 'Release', ['emr-7.5.0', 'emr-7.0.0', 'emr-6.15.0']),
      // Both sit inside `master_instance_group` and `core_instance_group`
      // blocks, which this emitter has no way to express.
      select('primaryInstanceType', 'Primary Node Type', ['m5.xlarge', 'm6g.xlarge', 'r5.xlarge']),
      num('coreInstanceCount', 'Core Nodes', 2),
      num('ebsRootVolumeSize', 'Root Volume (GB)', 30),
      bool('terminationProtection', 'Termination Protection', false),
    ],
    iac: {
      terraformResource: 'aws_emr_cluster',
      pulumiClass: 'aws.emr.Cluster',
      overrides: { primaryInstanceType: null, coreInstanceCount: null },
    },
  },
  {
    id: 'lake-formation',
    name: 'Lake Formation',
    shortName: 'Lake',
    category: 'analytics',
    description: 'Registers a data lake location and governs access to it',
    color: ANALYTICS_COLOUR,
    icon: 'lake-formation',
    allowedConnections: ['s3', 'glue', 'athena', 'emr', 'redshift'],
    properties: [
      text('arn', 'Location ARN', 'arn:aws:s3:::my-data-lake', true),
      bool('useServiceLinkedRole', 'Use Service-Linked Role', true),
      bool('hybridAccessEnabled', 'Allow IAM Access Alongside', false),
    ],
    iac: {
      terraformResource: 'aws_lakeformation_resource',
      pulumiClass: 'aws.lakeformation.Resource',
      taggable: false,
    },
  },
  {
    id: 'data-exchange',
    name: 'Data Exchange',
    shortName: 'Exchange',
    category: 'analytics',
    description: 'Publishes and subscribes to third-party data sets',
    color: ANALYTICS_COLOUR,
    icon: 'data-exchange',
    allowedConnections: ['s3', 'redshift', 'api-gateway'],
    properties: [
      text('name', 'Data Set Name', 'my-data-set', true),
      text('description', 'Description', 'Shared data set', true),
      select('assetType', 'Asset Type', [
        ['S3_SNAPSHOT', 'S3 snapshot'],
        ['REDSHIFT_DATA_SHARE', 'Redshift data share'],
        ['API_GATEWAY_API', 'API Gateway API'],
      ]),
    ],
    iac: {
      terraformResource: 'aws_dataexchange_data_set',
      pulumiClass: 'aws.dataexchange.DataSet',
    },
  },
  {
    id: 'finspace',
    name: 'FinSpace',
    shortName: 'FinSpace',
    category: 'analytics',
    description: 'Managed kdb+ environment for time-series analytics',
    color: ANALYTICS_COLOUR,
    icon: 'finspace',
    allowedConnections: ['s3'],
    properties: [
      text('name', 'Environment Name', 'my-environment', true),
      text('description', 'Description', ''),
      text('kmsKeyId', 'KMS Key', 'alias/aws/finspace', true),
    ],
    iac: {
      terraformResource: 'aws_finspace_kx_environment',
      pulumiClass: 'aws.finspace.KxEnvironment',
    },
  },
];
