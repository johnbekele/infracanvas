/**
 * Databases, caches, and analytical stores beyond the core three.
 *
 * A repository that runs MongoDB or Cassandra had nowhere to go before this:
 * the analyser detected it and the proposal reported a gap, which is honest but
 * not useful. These are the managed equivalents, with the properties that decide
 * what they cost -- instance class, node count, whether storage is provisioned.
 */
import type { AWSService } from '../aws-services';
import { bool, num, select, text } from './props';

const DB_COLOUR = '#4053D6';
const ANALYTICS_COLOUR = '#8C4FFF';

/** Sits in a private subnet and is reached from inside the VPC only. */
const privateOnly = {
  allowedInPublic: false,
  allowedInPrivate: true,
  requiresSubnet: true,
} as const;

export const dataServices: AWSService[] = [
  {
    id: 'aurora',
    name: 'Aurora',
    shortName: 'Aurora',
    category: 'database',
    description: 'MySQL and PostgreSQL compatible cluster',
    color: DB_COLOUR,
    icon: 'database',
    allowedConnections: ['ec2', 'ecs', 'lambda', 'eks-cluster'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('clusterIdentifier', 'Cluster Identifier', 'my-cluster', true),
      select('engine', 'Engine', [
        ['aurora-postgresql', 'Aurora PostgreSQL'],
        ['aurora-mysql', 'Aurora MySQL'],
      ]),
      select('capacityMode', 'Capacity', [
        ['provisioned', 'Provisioned instances'],
        ['serverless-v2', 'Serverless v2'],
      ]),
      select('instanceClass', 'Instance Class', [
        'db.r6g.large',
        'db.r6g.xlarge',
        'db.r7g.large',
        'db.t4g.medium',
      ]),
      num('minCapacityAcu', 'Min Capacity (ACU)', 0.5),
      num('maxCapacityAcu', 'Max Capacity (ACU)', 8),
      num('replicaCount', 'Reader Replicas', 1),
      bool('multiAz', 'Multi-AZ', true),
    ],
    iac: {
      terraformResource: 'aws_rds_cluster',
      pulumiClass: 'aws.rds.Cluster',
      overrides: { capacityMode: null, instanceClass: null },
    },
  },
  {
    id: 'documentdb',
    name: 'DocumentDB',
    shortName: 'DocDB',
    category: 'database',
    description: 'MongoDB-compatible document database',
    color: DB_COLOUR,
    icon: 'file-json',
    allowedConnections: ['ec2', 'ecs', 'lambda', 'eks-cluster'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('clusterIdentifier', 'Cluster Identifier', 'my-docdb', true),
      select('instanceClass', 'Instance Class', ['db.t4g.medium', 'db.r6g.large', 'db.r6g.xlarge']),
      num('instanceCount', 'Instances', 1),
      select('engineVersion', 'MongoDB API Version', ['5.0.0', '4.0.0'], '5.0.0'),
      bool('storageEncrypted', 'Encrypt Storage', true),
    ],
    iac: { terraformResource: 'aws_docdb_cluster', pulumiClass: 'aws.docdb.Cluster' },
  },
  {
    id: 'opensearch',
    name: 'OpenSearch Service',
    shortName: 'OpenSrch',
    category: 'database',
    description: 'Managed Elasticsearch-compatible search cluster',
    color: DB_COLOUR,
    icon: 'search',
    allowedConnections: ['ec2', 'ecs', 'lambda', 'kinesis'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('domainName', 'Domain Name', 'my-search', true),
      select('instanceType', 'Instance Type', [
        't3.small.search',
        'm6g.large.search',
        'r6g.large.search',
      ]),
      num('instanceCount', 'Data Nodes', 2),
      num('volumeSize', 'Storage per Node (GB)', 20),
      bool('dedicatedMaster', 'Dedicated Master Nodes', false),
    ],
    iac: { terraformResource: 'aws_opensearch_domain', pulumiClass: 'aws.opensearch.Domain' },
  },
  {
    id: 'neptune',
    name: 'Neptune',
    shortName: 'Neptune',
    category: 'database',
    description: 'Managed graph database',
    color: DB_COLOUR,
    icon: 'share-2',
    allowedConnections: ['ec2', 'ecs', 'lambda'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('clusterIdentifier', 'Cluster Identifier', 'my-graph', true),
      select('instanceClass', 'Instance Class', ['db.t4g.medium', 'db.r6g.large', 'db.r6g.xlarge']),
      num('instanceCount', 'Instances', 1),
      select('queryLanguage', 'Query Language', ['gremlin', 'opencypher', 'sparql']),
    ],
    iac: {
      terraformResource: 'aws_neptune_cluster',
      pulumiClass: 'aws.neptune.Cluster',
      overrides: { queryLanguage: null, instanceClass: null },
    },
  },
  {
    id: 'keyspaces',
    name: 'Keyspaces',
    shortName: 'Keysp',
    category: 'database',
    description: 'Serverless Cassandra-compatible store',
    color: DB_COLOUR,
    icon: 'columns-3',
    allowedConnections: ['ec2', 'ecs', 'lambda'],
    properties: [
      text('keyspaceName', 'Keyspace Name', 'my_keyspace', true),
      select('capacityMode', 'Capacity Mode', [
        ['PAY_PER_REQUEST', 'On demand'],
        ['PROVISIONED', 'Provisioned'],
      ]),
      num('readCapacityUnits', 'Read Capacity Units', 0),
      num('writeCapacityUnits', 'Write Capacity Units', 0),
    ],
    iac: { terraformResource: 'aws_keyspaces_keyspace', pulumiClass: 'aws.keyspaces.Keyspace' },
  },
  {
    id: 'memorydb',
    name: 'MemoryDB',
    shortName: 'MemDB',
    category: 'database',
    description: 'Durable Redis-compatible store',
    color: DB_COLOUR,
    icon: 'zap',
    allowedConnections: ['ec2', 'ecs', 'lambda', 'eks-cluster'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('clusterName', 'Cluster Name', 'my-memorydb', true),
      select('nodeType', 'Node Type', ['db.t4g.small', 'db.r6g.large', 'db.r6g.xlarge']),
      num('shardCount', 'Shards', 1),
      num('replicasPerShard', 'Replicas per Shard', 1),
    ],
    iac: { terraformResource: 'aws_memorydb_cluster', pulumiClass: 'aws.memorydb.Cluster' },
  },
  {
    id: 'efs',
    name: 'EFS',
    shortName: 'EFS',
    category: 'storage',
    description: 'Shared elastic file system',
    color: '#569A31',
    icon: 'hard-drive',
    allowedConnections: ['ec2', 'ecs', 'lambda', 'eks-cluster', 'batch'],
    subnetPlacement: privateOnly,
    allowedParents: ['private-subnet'],
    properties: [
      text('fileSystemName', 'File System Name', 'my-files', true),
      select('performanceMode', 'Performance Mode', ['generalPurpose', 'maxIO']),
      select('throughputMode', 'Throughput Mode', ['bursting', 'elastic', 'provisioned']),
      bool('encrypted', 'Encrypt at Rest', true),
    ],
    iac: { terraformResource: 'aws_efs_file_system', pulumiClass: 'aws.efs.FileSystem' },
  },
  {
    id: 'redshift',
    name: 'Redshift',
    shortName: 'Redshift',
    category: 'analytics',
    description: 'Columnar data warehouse',
    color: ANALYTICS_COLOUR,
    icon: 'bar-chart-3',
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
    icon: 'terminal',
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
    icon: 'layers',
    allowedConnections: ['s3', 'redshift', 'athena', 'rds'],
    properties: [
      text('jobName', 'Job Name', 'my-etl-job', true),
      select('workerType', 'Worker Type', ['G.1X', 'G.2X', 'G.4X', 'G.025X']),
      num('numberOfWorkers', 'Workers', 2),
      select('glueVersion', 'Glue Version', ['4.0', '3.0']),
    ],
    iac: { terraformResource: 'aws_glue_job', pulumiClass: 'aws.glue.Job' },
  },
];
