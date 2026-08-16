/**
 * Messaging, streaming, scheduling, and workflow services.
 *
 * These are what turn a set of services into a system. A worker is only a worker
 * because something hands it work, and until the catalog could express that, the
 * proposal drew workers with nothing connected to them.
 */
import type { AWSService } from '../aws-services';
import { bool, num, select, text } from './props';

const INTEGRATION_COLOUR = '#FF4F8B';

export const integrationServices: AWSService[] = [
  {
    id: 'eventbridge',
    name: 'EventBridge',
    shortName: 'Events',
    category: 'integration',
    description: 'Event bus, rules, and schedules',
    color: INTEGRATION_COLOUR,
    icon: 'calendar-clock',
    allowedConnections: ['lambda', 'ecs', 'sqs', 'sns', 'step-functions', 'batch'],
    properties: [
      text('ruleName', 'Rule Name', 'my-rule', true),
      select('triggerType', 'Trigger', [
        ['schedule', 'Schedule'],
        ['event-pattern', 'Event pattern'],
      ]),
      text('scheduleExpression', 'Schedule', 'rate(1 hour)'),
      bool('enabled', 'Enabled', true),
    ],
    iac: {
      terraformResource: 'aws_cloudwatch_event_rule',
      pulumiClass: 'aws.cloudwatch.EventRule',
      overrides: { triggerType: null },
    },
  },
  {
    id: 'step-functions',
    name: 'Step Functions',
    shortName: 'States',
    category: 'integration',
    description: 'Orchestrated state machines',
    color: INTEGRATION_COLOUR,
    icon: 'workflow',
    allowedConnections: ['lambda', 'ecs', 'batch', 'sqs', 'sns', 'bedrock', 'sagemaker-endpoint'],
    // AWS draws a workflow as a box around the steps it orchestrates. Being a
    // container does not change what it emits: the state machine is still a
    // resource. The parents are stated explicitly because a container that names
    // none is treated as one that never nests.
    isContainer: true,
    allowedParents: [
      'aws-cloud',
      'region',
      'aws-account',
      'vpc-environment',
      'public-subnet',
      'private-subnet',
    ],
    group: { stroke: '#CD2264', border: 'solid', showIcon: true },
    properties: [
      text('stateMachineName', 'State Machine Name', 'my-workflow', true),
      select('stateMachineType', 'Type', [
        ['STANDARD', 'Standard (durable, exactly-once)'],
        ['EXPRESS', 'Express (high volume, at-least-once)'],
      ]),
      num('expectedTransitionsPerMonth', 'Expected State Transitions per Month', 100000),
      bool('loggingEnabled', 'Log Execution History', true),
    ],
    iac: {
      terraformResource: 'aws_sfn_state_machine',
      pulumiClass: 'aws.sfn.StateMachine',
      overrides: { expectedTransitionsPerMonth: null },
    },
  },
  {
    id: 'kinesis',
    name: 'Kinesis Data Streams',
    shortName: 'Kinesis',
    category: 'integration',
    description: 'Ordered, replayable event stream',
    color: INTEGRATION_COLOUR,
    icon: 'kinesis',
    allowedConnections: ['lambda', 'ecs', 'firehose', 'opensearch', 's3', 'managed-flink'],
    properties: [
      text('streamName', 'Stream Name', 'my-stream', true),
      select('streamMode', 'Capacity Mode', [
        ['ON_DEMAND', 'On demand'],
        ['PROVISIONED', 'Provisioned shards'],
      ]),
      num('shardCount', 'Shards', 1),
      num('retentionHours', 'Retention (hours)', 24),
    ],
    iac: { terraformResource: 'aws_kinesis_stream', pulumiClass: 'aws.kinesis.Stream' },
  },
  {
    id: 'firehose',
    name: 'Data Firehose',
    shortName: 'Firehose',
    category: 'integration',
    description: 'Buffered delivery of streams to storage',
    color: INTEGRATION_COLOUR,
    icon: 'firehose',
    allowedConnections: ['s3', 'redshift', 'opensearch', 'kinesis'],
    properties: [
      text('deliveryStreamName', 'Delivery Stream Name', 'my-delivery', true),
      select('destination', 'Destination', ['extended_s3', 'redshift', 'opensearch']),
      num('bufferingSize', 'Buffer Size (MB)', 5),
      num('bufferingInterval', 'Buffer Interval (seconds)', 300),
    ],
    iac: {
      terraformResource: 'aws_kinesis_firehose_delivery_stream',
      pulumiClass: 'aws.kinesis.FirehoseDeliveryStream',
    },
  },
  {
    id: 'msk',
    name: 'MSK',
    shortName: 'Kafka',
    category: 'integration',
    description: 'Managed Kafka cluster',
    color: INTEGRATION_COLOUR,
    icon: 'msk',
    allowedConnections: ['ecs', 'ec2', 'lambda', 'eks', 'managed-flink'],
    subnetPlacement: { allowedInPublic: false, allowedInPrivate: true, requiresSubnet: true },
    allowedParents: ['private-subnet'],
    properties: [
      text('clusterName', 'Cluster Name', 'my-kafka', true),
      select('deployment', 'Deployment', [
        ['serverless', 'Serverless'],
        ['provisioned', 'Provisioned brokers'],
      ]),
      select('instanceType', 'Broker Type', [
        'kafka.t3.small',
        'kafka.m5.large',
        'kafka.m7g.large',
      ]),
      num('brokerCount', 'Brokers', 3),
      num('volumeSize', 'Storage per Broker (GB)', 100),
    ],
    iac: {
      terraformResource: 'aws_msk_cluster',
      pulumiClass: 'aws.msk.Cluster',
      overrides: { deployment: null },
    },
  },
  {
    id: 'kinesis-video-streams',
    name: 'Kinesis Video Streams',
    shortName: 'Video',
    category: 'integration',
    description: 'Ingests and replays media from devices',
    color: INTEGRATION_COLOUR,
    icon: 'kinesis-video-streams',
    allowedConnections: ['lambda', 'ecs', 's3', 'rekognition'],
    properties: [
      text('name', 'Stream Name', 'my-video-stream', true),
      num('dataRetentionInHours', 'Retention (hours)', 24),
      text('mediaType', 'Media Type', 'video/h264'),
    ],
    iac: {
      terraformResource: 'aws_kinesis_video_stream',
      pulumiClass: 'aws.kinesis.VideoStream',
    },
  },
  {
    id: 'managed-flink',
    name: 'Managed Service for Apache Flink',
    shortName: 'Flink',
    category: 'integration',
    description: 'Stateful stream processing over Kinesis and Kafka',
    color: INTEGRATION_COLOUR,
    icon: 'managed-flink',
    allowedConnections: ['kinesis', 'firehose', 'msk', 's3', 'opensearch'],
    properties: [
      text('name', 'Application Name', 'my-flink-app', true),
      select('runtimeEnvironment', 'Runtime', ['FLINK-1_20', 'FLINK-1_19', 'FLINK-1_18']),
      text('description', 'Description', ''),
      bool('startApplication', 'Start on Deploy', true),
    ],
    iac: {
      terraformResource: 'aws_kinesisanalyticsv2_application',
      pulumiClass: 'aws.kinesisanalyticsv2.Application',
    },
  },
  {
    id: 'amazon-mq',
    name: 'Amazon MQ',
    shortName: 'MQ',
    category: 'integration',
    description: 'Managed RabbitMQ or ActiveMQ broker',
    color: INTEGRATION_COLOUR,
    icon: 'rabbit',
    allowedConnections: ['ecs', 'ec2', 'lambda'],
    subnetPlacement: { allowedInPublic: false, allowedInPrivate: true, requiresSubnet: true },
    allowedParents: ['private-subnet'],
    properties: [
      text('brokerName', 'Broker Name', 'my-broker', true),
      select('engineType', 'Engine', ['RabbitMQ', 'ActiveMQ']),
      select('hostInstanceType', 'Instance Type', ['mq.t3.micro', 'mq.m5.large', 'mq.m5.xlarge']),
      select('deploymentMode', 'Deployment', [
        ['SINGLE_INSTANCE', 'Single instance'],
        ['CLUSTER_MULTI_AZ', 'Cluster, multi-AZ'],
      ]),
    ],
    iac: { terraformResource: 'aws_mq_broker', pulumiClass: 'aws.mq.Broker' },
  },
  {
    id: 'ses',
    name: 'SES',
    shortName: 'SES',
    category: 'integration',
    description: 'Transactional email delivery',
    color: INTEGRATION_COLOUR,
    icon: 'mail',
    allowedConnections: ['ecs', 'lambda', 'ec2', 'sns'],
    properties: [
      text('domainIdentity', 'Sending Domain', 'example.com', true),
      select('tlsPolicy', 'TLS Policy', ['Require', 'Optional']),
      num('expectedEmailsPerMonth', 'Expected Emails per Month', 10000),
      bool('dkimEnabled', 'Enable DKIM', true),
    ],
    iac: {
      terraformResource: 'aws_sesv2_email_identity',
      pulumiClass: 'aws.sesv2.EmailIdentity',
      overrides: { expectedEmailsPerMonth: null },
    },
  },
  {
    id: 'appsync',
    name: 'AppSync',
    shortName: 'AppSync',
    category: 'integration',
    description: 'Managed GraphQL API',
    color: INTEGRATION_COLOUR,
    icon: 'braces',
    allowedConnections: ['lambda', 'dynamodb', 'rds', 'opensearch', 'cognito'],
    properties: [
      text('apiName', 'API Name', 'my-graphql-api', true),
      select('authenticationType', 'Authentication', [
        'API_KEY',
        'AMAZON_COGNITO_USER_POOLS',
        'AWS_IAM',
        'OPENID_CONNECT',
      ]),
      bool('xrayEnabled', 'Enable X-Ray', false),
      bool('realtimeEnabled', 'Enable Subscriptions', true),
    ],
    iac: {
      terraformResource: 'aws_appsync_graphql_api',
      pulumiClass: 'aws.appsync.GraphQLApi',
      overrides: { realtimeEnabled: null },
    },
  },
];
