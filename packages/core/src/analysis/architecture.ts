/**
 * Turning an application profile into an AWS architecture.
 *
 * These are coded rules, not a model. "A Postgres client means a managed
 * Postgres instance" is a decision anyone can read, argue with, and change in
 * one place, and it produces the same architecture every time for the same
 * profile. A model may later improve the judgements -- sizing, whether a
 * workload suits Lambda -- but the mapping from a dependency to a service is
 * not a judgement, and asking a model for it only makes it unpredictable.
 *
 * The engine is driven by the repository's deployable components rather than by
 * a template. A repository that ships seven services gets seven services: a
 * single box standing in for all of them is not a simplification, it is a
 * different architecture, and it hides exactly the decisions the user came here
 * to make.
 *
 * Every node carries the files it was inferred from and how strong that
 * inference is, because a user has to be able to reject a suggestion, and they
 * can only do that if they can see what it rests on.
 */
import { awsServices, type AWSService } from '../aws-services';
import {
  deployables,
  hasCapability,
  type AppProfile,
  type Capability,
  type Component,
  type ComposeService,
} from './profile';
import {
  MIN_CONTAINER,
  NODE_SIZE,
  columnsFor,
  contain,
  gridLayout,
  offset,
  stack,
  type Placed,
  type Position,
  type Size,
} from './layout';

/**
 * How much the profile actually supports a node.
 *
 * `high` means the repository states it: a compose service running Postgres, a
 * Dockerfile for a service. `medium` means it is implied but not stated: a
 * Postgres driver with nothing saying how many databases there are. `low` means
 * this is a substitution -- an AWS service standing in for something the
 * application currently uses elsewhere -- and is the level at which a user
 * should expect to disagree.
 */
export type Confidence = 'high' | 'medium' | 'low';

export interface ProposedNode {
  id: string;
  serviceId: string;
  /** Relative to `parentId` when nested, absolute otherwise, as React Flow expects. */
  position: Position;
  parentId?: string;
  size?: Size;
  properties: Record<string, string | number | boolean>;
  /** Repository paths this node was inferred from. Empty for structural defaults. */
  evidence: string[];
  confidence: Confidence;
  /** The component this node deploys, when it deploys one. */
  componentPath?: string;
}

export interface ProposedEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ArchitectureDecision {
  /** The node this decision produced, so the canvas can link the two. */
  nodeId: string;
  title: string;
  rationale: string;
  /** Repository paths the decision was drawn from. Empty for structural defaults. */
  evidence: string[];
  confidence: Confidence;
}

export interface ArchitectureProposal {
  name: string;
  nodes: ProposedNode[];
  edges: ProposedEdge[];
  decisions: ArchitectureDecision[];
  /**
   * Things the profile found that this catalog has no service for. Reported
   * rather than silently dropped: a missing queue is the difference between an
   * architecture that works and one that looks like it does.
   */
  gaps: string[];
}

const serviceIndex = new Map<string, AWSService>(
  awsServices.map((service) => [service.id, service])
);

/** A service's declared defaults, which keeps the canvas consistent with manual placement. */
function defaultProperties(serviceId: string): Record<string, string | number | boolean> {
  const service = serviceIndex.get(serviceId);
  if (!service) return {};

  const properties: Record<string, string | number | boolean> = {};
  for (const property of service.properties) {
    properties[property.name] = property.default;
  }
  return properties;
}

/** Sanitises a name into something AWS accepts as a resource name. */
export function resourceName(name: string, suffix: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 32);

  // Trimmed by index rather than with a pattern. An unanchored `-+$` is retried
  // from every position, so a name that is mostly separators costs quadratic
  // time, and the name comes from outside this system.
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === '-') start += 1;
  while (end > start && slug[end - 1] === '-') end -= 1;

  const base = slug.slice(start, end);

  return `${base || 'app'}-${suffix}`;
}

/** A stable node id fragment for a component path. */
function slugFor(path: string): string {
  const slug = path.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  let start = 0;
  let end = slug.length;
  while (start < end && slug[start] === '-') start += 1;
  while (end > start && slug[end - 1] === '-') end -= 1;
  return slug.slice(start, end) || 'root';
}

/** What each capability would need, when the catalog has no service for it. */
const CAPABILITY_LABELS: Partial<Record<Capability, string>> = {
  mongodb: 'MongoDB (DocumentDB)',
  elasticsearch: 'Elasticsearch (OpenSearch Service)',
  kafka: 'Kafka (Amazon MSK)',
  rabbitmq: 'RabbitMQ (Amazon MQ)',
  cassandra: 'Cassandra (Amazon Keyspaces)',
  clickhouse: 'ClickHouse',
  'graph-db': 'a graph database (Amazon Neptune)',
  email: 'email delivery (Amazon SES)',
  identity: 'user identity (Amazon Cognito)',
  'vector-search': 'vector search (OpenSearch Serverless)',
  'llm-api': 'a hosted model (Amazon Bedrock)',
  'document-processing': 'document extraction (Amazon Textract)',
  streaming: 'stream processing (Amazon Kinesis)',
  'workflow-orchestration': 'workflow orchestration (AWS Step Functions)',
  'scheduled-jobs': 'scheduling (Amazon EventBridge)',
  secrets: 'secret storage (AWS Secrets Manager)',
  observability: 'metrics and traces (Amazon CloudWatch)',
  'feature-store': 'a feature store (SageMaker Feature Store)',
};

/** What a private subnet holds: the container cluster, or a node on its own. */
type PrivateChild = { kind: 'cluster' } | { kind: 'draft'; draft: Draft };

/** A node the engine wants to place, before it has a position. */
interface Draft {
  id: string;
  serviceId: string;
  properties: Record<string, string | number | boolean>;
  evidence: string[];
  confidence: Confidence;
  componentPath?: string;
  title: string;
  rationale: string;
}

/** Distinct paths, in a stable order, for use as evidence. */
function paths(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Every manifest path that gave a component the capability. */
function evidenceForCapability(component: Component, capability: Capability): string[] {
  return paths(
    component.dependencies
      .filter((dependency) => dependency.capability === capability)
      .map((dependency) => dependency.sourcePath)
  );
}

const SERVING: Capability[] = ['http-server', 'graphql', 'grpc', 'websocket', 'mcp-server'];
const ACCELERATED: Capability[] = ['gpu-inference'];

function componentPort(component: Component, composeServices: ComposeService[]): number | null {
  if (component.exposedPorts.length === 1) return component.exposedPorts[0];

  const compose = composeServices.find((service) => service.name === component.composeService);
  if (compose && compose.ports.length === 1) return compose.ports[0];

  // Several ports, or none. Picking one would be a guess written into a
  // security group, so it is left unset and reported.
  return null;
}

/**
 * Propose an architecture for a profile.
 *
 * Returns a proposal with no compute when the profile shows no runnable
 * application -- a documentation repository, or a library with no server -- in
 * preference to inventing a workload to justify a diagram.
 */
export function proposeArchitecture(
  profile: AppProfile,
  repositoryName: string
): ArchitectureProposal {
  const gaps: string[] = [];
  const edges: ProposedEdge[] = [];

  /** Record a capability the catalog cannot express, once. */
  const reportGap = (capability: Capability, detail: string) => {
    const label = CAPABILITY_LABELS[capability] ?? capability;
    const message = `${label} was detected. ${detail}`;
    if (!gaps.includes(message)) gaps.push(message);
  };

  /** Keep a draft only if the catalog can draw it; otherwise say so. */
  const keep = (draft: Draft, capability?: Capability): Draft | null => {
    if (serviceIndex.has(draft.serviceId)) return draft;
    if (capability) {
      reportGap(
        capability,
        `The service catalog has no entry for ${draft.serviceId} yet, so no node was added for it.`
      );
    }
    return null;
  };

  const deployed = deployables(profile);
  const frontends = deployed.filter((component) => component.kind === 'frontend');
  const runnable = deployed.filter((component) => component.kind !== 'frontend');

  if (frontends.length === 0 && runnable.length === 0) {
    return {
      name: `${repositoryName} architecture`,
      nodes: [],
      edges: [],
      decisions: [],
      gaps: [
        'No deployable component was found: nothing here declares a web framework, a container, or a front end build. Design an architecture on the canvas instead, or connect a repository that runs a service.',
      ],
    };
  }

  // --- Front ends: one bucket and distribution per built site -----------------

  interface FrontendPair {
    bucket: Draft;
    cdn: Draft;
  }

  const frontendPairs: FrontendPair[] = [];
  for (const component of frontends) {
    const slug = slugFor(component.path);
    const evidence = paths([...component.manifestPaths, ...component.dockerfiles]);

    const bucket = keep(
      {
        id: `frontend-bucket-${slug}`,
        serviceId: 's3',
        properties: {
          ...defaultProperties('s3'),
          bucketName: resourceName(component.name, 'site'),
          staticHosting: true,
        },
        evidence,
        confidence: 'high',
        componentPath: component.path,
        title: `Static hosting for ${component.name}`,
        rationale:
          'This component builds a front end bundle, which is a set of files rather than a running process. S3 stores them and costs nothing to keep idle.',
      },
      'frontend'
    );

    const cdn = keep(
      {
        id: `frontend-cdn-${slug}`,
        serviceId: 'cloudfront',
        properties: { ...defaultProperties('cloudfront') },
        evidence,
        confidence: 'high',
        componentPath: component.path,
        title: `CDN for ${component.name}`,
        rationale:
          'A bucket alone has no TLS on a custom domain and serves every request from one region. CloudFront supplies both, and caches the bundle at the edge.',
      },
      'frontend'
    );

    if (bucket && cdn) frontendPairs.push({ bucket, cdn });
  }

  // --- Compute: one node per runnable component -------------------------------

  const computeDrafts: Draft[] = [];
  const computeByPath = new Map<string, Draft>();
  let sagemakerCount = 0;

  for (const component of runnable) {
    const slug = slugFor(component.path);
    const evidence = paths([...component.manifestPaths, ...component.dockerfiles]);
    const packaged = component.dockerfiles.length > 0 || component.composeService !== null;
    const accelerated = ACCELERATED.some((capability) =>
      component.capabilities.includes(capability)
    );
    const serves = SERVING.some((capability) => component.capabilities.includes(capability));

    // A component that only runs a model, and answers nothing, is an inference
    // endpoint rather than a service: SageMaker manages the scaling and the
    // model artefact that ECS would leave to the user.
    if (component.kind === 'ml-service' && !serves) {
      const endpoint = keep(
        {
          id: `inference-${slug}`,
          serviceId: 'sagemaker-endpoint',
          properties: {
            ...defaultProperties('sagemaker-endpoint'),
            endpointName: resourceName(component.name, 'endpoint'),
          },
          evidence,
          confidence: 'medium',
          componentPath: component.path,
          title: `Model endpoint for ${component.name}`,
          rationale:
            'This component runs inference and serves no request path of its own. A managed endpoint handles model loading and scale-to-zero, which a container would leave to you.',
        },
        'ml-inference'
      );
      if (endpoint) {
        computeDrafts.push(endpoint);
        computeByPath.set(component.path, endpoint);
        sagemakerCount += 1;
        continue;
      }
    }

    const port = componentPort(component, profile.composeServices);
    if (component.exposedPorts.length > 1) {
      gaps.push(
        `${component.name} exposes ports ${component.exposedPorts.join(', ')}, so the one to route to could not be determined. Set it on the compute node before generating code.`
      );
    }

    const serviceId = packaged ? 'ecs' : 'ec2';
    const draft = keep({
      id: `compute-${slug}`,
      serviceId,
      properties: {
        ...defaultProperties(serviceId),
        ...(packaged ? { serviceName: resourceName(component.name, 'svc') } : {}),
        ...(port === null ? {} : { containerPort: port }),
      },
      evidence,
      confidence: packaged ? 'high' : 'medium',
      componentPath: component.path,
      title: `${component.kind === 'worker' ? 'Worker' : 'Service'} for ${component.name}`,
      rationale: packaged
        ? `${component.name} builds a container image, so it runs as its own ECS service and scales independently of the rest.${
            accelerated
              ? ' It also depends on GPU libraries, so it needs an accelerated instance type rather than Fargate.'
              : ''
          }${
            component.kind === 'worker'
              ? ' It consumes work rather than answering requests, so nothing routes to it from the load balancer.'
              : ''
          }`
        : `${component.name} declares a server but ships no container image, so it is proposed on EC2. Adding a Dockerfile would let it run as an ECS service instead.`,
    });

    if (draft) {
      computeDrafts.push(draft);
      computeByPath.set(component.path, draft);
    }
  }

  const ecsServices = computeDrafts.filter((draft) => draft.serviceId === 'ecs');
  const needsVpc = computeDrafts.length > sagemakerCount;

  // --- Shared data stores -----------------------------------------------------

  const dataDrafts: Draft[] = [];
  const nodeForCapability = new Map<Capability, Draft[]>();

  const remember = (capability: Capability, draft: Draft) => {
    const existing = nodeForCapability.get(capability);
    if (existing) existing.push(draft);
    else nodeForCapability.set(capability, [draft]);
  };

  /**
   * Compose services running an image are the strongest statement a repository
   * makes about its data stores: it names them, and there are as many as it
   * declares. Drivers alone say a kind of database is used, not how many.
   */
  const managedByCompose = (capability: Capability) =>
    profile.composeServices.filter((service) => service.capability === capability);

  const componentsNeeding = (capability: Capability) =>
    deployed.filter((component) => component.capabilities.includes(capability));

  const driverEvidence = (capability: Capability) =>
    paths(deployed.flatMap((component) => evidenceForCapability(component, capability)));

  const addRelational = () => {
    const composePostgres = managedByCompose('postgres');
    const composeMysql = managedByCompose('mysql');
    const declared = [
      ...composePostgres.map((service) => ({ service, engine: 'postgres', label: 'PostgreSQL' })),
      ...composeMysql.map((service) => ({ service, engine: 'mysql', label: 'MySQL' })),
    ];

    if (declared.length > 0) {
      for (const { service, engine, label } of declared) {
        const draft = keep(
          {
            id: `database-${slugFor(service.name)}`,
            serviceId: 'rds',
            properties: {
              ...defaultProperties('rds'),
              engine,
              identifier: resourceName(service.name, 'db'),
            },
            evidence: [service.file],
            confidence: 'high',
            title: `${label} for ${service.name}`,
            rationale: `The compose file declares a ${label} service named ${service.name}, so this repository runs a database of its own rather than sharing one. RDS is the managed equivalent.`,
          },
          engine === 'postgres' ? 'postgres' : 'mysql'
        );
        if (draft) {
          dataDrafts.push(draft);
          remember(engine === 'postgres' ? 'postgres' : 'mysql', draft);
        }
      }
      return;
    }

    const usesPostgres = hasCapability(profile, 'postgres');
    const usesMysql = hasCapability(profile, 'mysql');
    if (!usesPostgres && !usesMysql) return;

    // Postgres wins when both appear: a repository with both drivers is usually
    // migrating, and the newer target is the safer default to draw.
    const capability: Capability = usesPostgres ? 'postgres' : 'mysql';
    const label = usesPostgres ? 'PostgreSQL' : 'MySQL';

    const draft = keep(
      {
        id: 'database-primary',
        serviceId: 'rds',
        properties: {
          ...defaultProperties('rds'),
          engine: capability,
          identifier: resourceName(repositoryName, 'db'),
        },
        evidence: driverEvidence(capability),
        confidence: 'medium',
        title: `${label} database`,
        rationale: `${componentsNeeding(capability).length} component(s) declare a ${label} client, but nothing states how many databases there are, so one shared instance is proposed. Split it if these components should not share storage.`,
      },
      capability
    );
    if (draft) {
      dataDrafts.push(draft);
      remember(capability, draft);
    }
  };

  addRelational();

  const addSimpleStore = (
    capability: Capability,
    serviceId: string,
    idPrefix: string,
    title: string,
    stated: string,
    implied: string,
    extraProperties: Record<string, string | number | boolean> = {}
  ) => {
    const composeServices = managedByCompose(capability);
    const needing = componentsNeeding(capability);
    if (composeServices.length === 0 && needing.length === 0) return;

    const fromCompose = composeServices.length > 0;
    const draft = keep(
      {
        id: `${idPrefix}-primary`,
        serviceId,
        properties: { ...defaultProperties(serviceId), ...extraProperties },
        evidence: fromCompose
          ? paths(composeServices.map((service) => service.file))
          : driverEvidence(capability),
        confidence: fromCompose ? 'high' : 'medium',
        title,
        rationale: fromCompose ? stated : implied,
      },
      capability
    );

    if (draft) {
      dataDrafts.push(draft);
      remember(capability, draft);
    }
  };

  addSimpleStore(
    'redis',
    'elasticache',
    'cache',
    'Redis cache',
    'The compose file runs Redis alongside the application, so ElastiCache replaces it.',
    'A Redis client is declared but nothing states what it holds. ElastiCache covers both caching and the broker a task queue needs.'
  );

  addSimpleStore(
    'mongodb',
    'documentdb',
    'documents',
    'Document database',
    'The compose file runs MongoDB, so DocumentDB is the managed equivalent.',
    'A MongoDB client is declared. DocumentDB is the managed equivalent, subject to the API version it supports.'
  );

  addSimpleStore(
    'elasticsearch',
    'opensearch',
    'search',
    'Search cluster',
    'The compose file runs Elasticsearch or OpenSearch, so OpenSearch Service replaces it.',
    'An Elasticsearch or OpenSearch client is declared, so a managed search cluster is proposed.'
  );

  addSimpleStore(
    'graph-db',
    'neptune',
    'graph',
    'Graph database',
    'The compose file runs a graph database, so Neptune is the managed equivalent.',
    'A graph database client is declared, so Neptune is proposed.'
  );

  addSimpleStore(
    'cassandra',
    'keyspaces',
    'wide-column',
    'Wide-column store',
    'The compose file runs Cassandra or Scylla, so Keyspaces is the managed equivalent.',
    'A Cassandra client is declared, so Keyspaces is proposed.'
  );

  addSimpleStore(
    'dynamodb',
    'dynamodb',
    'keyvalue',
    'Key-value tables',
    'A DynamoDB client is declared.',
    'A DynamoDB client is declared, so a table is proposed. Its keys come from the application, not from the manifest.'
  );

  // Vector search sits on the relational instance when the dependency is
  // pgvector, because that is an extension rather than another system to run.
  const vectorDependencies = paths(
    deployed.flatMap((component) =>
      component.dependencies
        .filter((dependency) => dependency.capability === 'vector-search')
        .map((dependency) => dependency.name.toLowerCase())
    )
  );
  const pgvectorOnly =
    vectorDependencies.length > 0 &&
    vectorDependencies.every((name) => name === 'pgvector') &&
    managedByCompose('vector-search').length === 0 &&
    (nodeForCapability.get('postgres')?.length ?? 0) > 0;

  if (pgvectorOnly) {
    const database = nodeForCapability.get('postgres')?.[0];
    if (database) {
      database.rationale +=
        ' It also carries the vectors: pgvector is an extension, not another service to run.';
    }
  } else {
    addSimpleStore(
      'vector-search',
      'opensearch-vector',
      'vectors',
      'Vector store',
      'The compose file runs a vector database, so a managed vector collection replaces it.',
      'A vector database client is declared, so a managed vector collection is proposed.'
    );
  }

  addSimpleStore(
    'clickhouse',
    'redshift',
    'analytics',
    'Analytical store',
    'The compose file runs ClickHouse. Redshift is the closest managed analytical store, though the query dialect differs.',
    'A ClickHouse client is declared. Redshift is the closest managed analytical store, though the query dialect differs.'
  );

  // --- Services outside the VPC ----------------------------------------------

  const externalDrafts: Draft[] = [];

  const addExternal = (
    capability: Capability,
    serviceId: string,
    id: string,
    title: string,
    rationale: string,
    confidence: Confidence = 'medium',
    extraProperties: Record<string, string | number | boolean> = {},
    // A node is usually needed because its own capability was found. Where it is
    // needed because of a different one -- a key store exists because a model
    // API is called, not because anything declared a secrets client -- both the
    // condition and the evidence come from that other capability instead.
    options: { when?: boolean; evidenceFrom?: Capability } = {}
  ) => {
    if (!(options.when ?? hasCapability(profile, capability))) return;

    const draft = keep(
      {
        id,
        serviceId,
        properties: { ...defaultProperties(serviceId), ...extraProperties },
        evidence: driverEvidence(options.evidenceFrom ?? capability),
        confidence,
        title,
        rationale,
      },
      capability
    );

    if (draft) {
      externalDrafts.push(draft);
      remember(capability, draft);
    }
  };

  const workers = runnable.filter((component) => component.kind === 'worker');
  const usesQueue = hasCapability(profile, 'background-jobs') || workers.length > 0;

  if (usesQueue) {
    const draft = keep(
      {
        id: 'queue-primary',
        serviceId: 'sqs',
        properties: {
          ...defaultProperties('sqs'),
          queueName: resourceName(repositoryName, 'jobs'),
        },
        evidence: paths([
          ...driverEvidence('background-jobs'),
          ...workers.flatMap((component) => component.manifestPaths),
        ]),
        confidence: 'high',
        title: 'Work queue',
        rationale: `${workers.length > 0 ? `${workers.length} component(s) run as workers` : 'A task queue library is declared'}, so work is handed off rather than done in the request. SQS is the managed queue; the broker the library expects may need configuration to match.`,
      },
      'background-jobs'
    );
    if (draft) {
      externalDrafts.push(draft);
      remember('background-jobs', draft);
    }
  }

  addExternal(
    'object-storage',
    's3',
    'storage-objects',
    'Object storage',
    'An object storage client is declared, so the application stores files outside its own filesystem. A bucket gives it somewhere durable to put them.',
    'high',
    { bucketName: resourceName(repositoryName, 'data') }
  );

  // A hosted model is either called through Bedrock, in which case IAM covers
  // access, or through a third party, in which case the key has to live
  // somewhere and Bedrock is a substitution the user may not want.
  const llmDependencyNames = deployed.flatMap((component) =>
    component.dependencies
      .filter((dependency) => dependency.capability === 'llm-api')
      .map((dependency) => dependency.name.toLowerCase())
  );
  const usesBedrockDirectly = llmDependencyNames.some((name) => name.includes('bedrock'));

  if (hasCapability(profile, 'llm-api')) {
    if (usesBedrockDirectly) {
      addExternal(
        'llm-api',
        'bedrock',
        'model-bedrock',
        'Managed models',
        'The application already calls Bedrock, so access is granted by IAM and no key needs storing.',
        'high'
      );
    } else {
      addExternal(
        'secrets',
        'secrets-manager',
        'secrets-llm',
        'Model provider credentials',
        `The application calls a hosted model (${[...new Set(llmDependencyNames)].slice(0, 3).join(', ')}), so an API key has to be supplied at runtime. Secrets Manager holds it instead of the task definition.`,
        'high',
        { secretName: `${resourceName(repositoryName, 'llm')}/api-key` },
        { when: true, evidenceFrom: 'llm-api' }
      );
      addExternal(
        'llm-api',
        'bedrock',
        'model-bedrock',
        'Managed models, as an alternative',
        'The application calls a third-party model API. Bedrock would remove the key and keep the traffic inside AWS, but it is a substitution rather than something the repository asked for -- remove it to keep the current provider.',
        'low'
      );
    }
  }

  addExternal(
    'document-processing',
    'textract',
    'documents-extract',
    'Document extraction',
    'Document parsing libraries are declared. Textract covers scanned and photographed documents that a parser alone cannot read, and can run alongside rather than instead of them.',
    'low'
  );

  addExternal(
    'kafka',
    'msk',
    'streaming-kafka',
    'Kafka cluster',
    'A Kafka client is declared, so MSK is proposed rather than running brokers on instances.'
  );

  addExternal(
    'rabbitmq',
    'amazon-mq',
    'broker-rabbitmq',
    'Message broker',
    'A RabbitMQ client is declared. Amazon MQ runs the same broker, so the application does not have to change protocol.'
  );

  addExternal(
    'streaming',
    'kinesis',
    'streaming-kinesis',
    'Event stream',
    'A streaming client is declared, so an ordered, replayable stream is proposed rather than a queue.'
  );

  addExternal(
    'workflow-orchestration',
    'step-functions',
    'workflow-primary',
    'Workflow orchestration',
    'A workflow engine is declared. Step Functions covers the same shape of work without a control plane to run, though a long-lived engine like Temporal may be doing more than it can express.',
    'low'
  );

  addExternal(
    'scheduled-jobs',
    'eventbridge',
    'schedule-primary',
    'Scheduled work',
    'A scheduler is declared, so work runs on a timer. An EventBridge rule triggers it without a process that has to stay up to keep time.'
  );

  addExternal(
    'email',
    'ses',
    'email-primary',
    'Email delivery',
    'An email client is declared, so SES is proposed. Sending from a new account is rate limited until the account is moved out of the sandbox.'
  );

  addExternal(
    'identity',
    'cognito',
    'identity-primary',
    'User identity',
    'An authentication library is declared. Cognito can hold the user pool, though an application that manages its own sessions may only need it for federation.',
    'low'
  );

  addExternal(
    'observability',
    'cloudwatch',
    'observability-primary',
    'Metrics and traces',
    'Instrumentation libraries are declared, so the application already emits telemetry. CloudWatch gives it somewhere to land without running a collector.'
  );

  // --- Structural nodes and layout -------------------------------------------

  const nodes: ProposedNode[] = [];
  const decisions: ArchitectureDecision[] = [];

  const emit = (draft: Draft, position: Position, parentId?: string, size?: Size) => {
    nodes.push({
      id: draft.id,
      serviceId: draft.serviceId,
      position,
      ...(parentId ? { parentId } : {}),
      ...(size ? { size } : {}),
      properties: draft.properties,
      evidence: draft.evidence,
      confidence: draft.confidence,
      ...(draft.componentPath ? { componentPath: draft.componentPath } : {}),
    });
    decisions.push({
      nodeId: draft.id,
      title: draft.title,
      rationale: draft.rationale,
      evidence: draft.evidence,
      confidence: draft.confidence,
    });
  };

  const leaf = <T>(item: T) => ({ item, size: NODE_SIZE });

  // Front end column, to the left of everything, since traffic starts there.
  let frontendColumnWidth = 0;
  let y = 40;
  for (const pair of frontendPairs) {
    emit(pair.bucket, { x: 40, y });
    emit(pair.cdn, { x: 40, y: y + NODE_SIZE.height + 56 });
    y += NODE_SIZE.height * 2 + 56 + 72;
    frontendColumnWidth = NODE_SIZE.width + 80;
  }

  const vpcOrigin: Position = { x: 40 + frontendColumnWidth, y: 40 };
  let vpcSize: Size = { width: 0, height: 0 };
  let albDraft: Draft | null = null;

  if (needsVpc) {
    albDraft = keep({
      id: 'ingress-alb',
      serviceId: 'alb',
      properties: { ...defaultProperties('alb') },
      evidence: [],
      confidence: 'high',
      title: 'Load balancer',
      rationale:
        'Requests have to reach the services without exposing them directly, and each service gets a target group and a listener rule rather than a public address of its own.',
    });

    const publicContent = gridLayout(albDraft ? [leaf(albDraft)] : [], 1);
    const publicSubnet = contain(publicContent, MIN_CONTAINER.subnet);

    const clusterContent = gridLayout(ecsServices.map(leaf), columnsFor(ecsServices.length));
    const cluster = contain(clusterContent, MIN_CONTAINER.cluster);

    const nonEcsCompute = computeDrafts.filter(
      (draft) => draft.serviceId !== 'ecs' && draft.serviceId !== 'sagemaker-endpoint'
    );

    // The subnet holds a mix of one container and many leaves, so its children
    // are tagged rather than relying on the shape of what is being placed.
    const asCluster: PrivateChild = { kind: 'cluster' };
    const asDraft = (draft: Draft): { item: PrivateChild; size: Size } => ({
      item: { kind: 'draft', draft },
      size: NODE_SIZE,
    });

    const privateContent = stack<PrivateChild>([
      ...(ecsServices.length > 0
        ? [gridLayout<PrivateChild>([{ item: asCluster, size: cluster.size }], 1)]
        : []),
      gridLayout(nonEcsCompute.map(asDraft), columnsFor(nonEcsCompute.length)),
      gridLayout(dataDrafts.map(asDraft), columnsFor(dataDrafts.length)),
    ]);
    const privateSubnet = contain(privateContent, MIN_CONTAINER.subnet);

    const subnets = gridLayout(
      [
        { item: 'public' as const, size: publicSubnet.size },
        { item: 'private' as const, size: privateSubnet.size },
      ],
      2
    );
    const vpc = contain(subnets, MIN_CONTAINER.vpc);
    vpcSize = vpc.size;

    nodes.push({
      id: 'network-vpc',
      serviceId: 'vpc-environment',
      position: vpcOrigin,
      size: vpc.size,
      properties: {
        ...defaultProperties('vpc-environment'),
        name: resourceName(repositoryName, 'vpc'),
      },
      evidence: [],
      confidence: 'high',
    });
    decisions.push({
      nodeId: 'network-vpc',
      title: 'Private network',
      rationale:
        'Every compute and data node below sits inside this network. Nothing reaches the databases except through a service in the same VPC.',
      evidence: [],
      confidence: 'high',
    });

    const publicPlacement = vpc.placed.find((entry) => entry.item === 'public');
    const privatePlacement = vpc.placed.find((entry) => entry.item === 'private');

    if (publicPlacement) {
      nodes.push({
        id: 'network-public',
        serviceId: 'public-subnet',
        position: publicPlacement.position,
        parentId: 'network-vpc',
        size: publicSubnet.size,
        properties: { ...defaultProperties('public-subnet') },
        evidence: [],
        confidence: 'high',
      });
      decisions.push({
        nodeId: 'network-public',
        title: 'Public subnet',
        rationale:
          'Holds only what has to be reachable from the internet, which is the load balancer.',
        evidence: [],
        confidence: 'high',
      });

      for (const entry of publicSubnet.placed) {
        emit(entry.item, entry.position, 'network-public');
      }
    }

    if (privatePlacement) {
      nodes.push({
        id: 'network-private',
        serviceId: 'private-subnet',
        position: privatePlacement.position,
        parentId: 'network-vpc',
        size: privateSubnet.size,
        properties: { ...defaultProperties('private-subnet') },
        evidence: [],
        confidence: 'high',
      });
      decisions.push({
        nodeId: 'network-private',
        title: 'Private subnet',
        rationale:
          'Services and data stores sit here with no route in from the internet. They are reached through the load balancer or from inside the network.',
        evidence: [],
        confidence: 'high',
      });

      for (const entry of privateSubnet.placed) {
        if (entry.item.kind === 'cluster') {
          nodes.push({
            id: 'compute-cluster',
            serviceId: 'ecs-cluster',
            position: entry.position,
            parentId: 'network-private',
            size: cluster.size,
            properties: {
              ...defaultProperties('ecs-cluster'),
              clusterName: resourceName(repositoryName, 'cluster'),
            },
            evidence: [],
            confidence: 'high',
          });
          decisions.push({
            nodeId: 'compute-cluster',
            title: 'Container cluster',
            rationale: `${ecsServices.length} service(s) run as containers, and they share one cluster so capacity and networking are configured once rather than per service.`,
            evidence: [],
            confidence: 'high',
          });

          for (const inner of cluster.placed) {
            emit(inner.item, inner.position, 'compute-cluster');
          }
          continue;
        }

        emit(entry.item.draft, entry.position, 'network-private');
      }
    }
  } else {
    // No VPC: place whatever compute there is beside the front ends.
    const block = gridLayout(computeDrafts.map(leaf), columnsFor(computeDrafts.length));
    for (const entry of offset(block.placed, vpcOrigin)) {
      emit(entry.item, entry.position);
    }
    vpcSize = block.size;
  }

  // Managed services that are not in the VPC, in a column to its right.
  const sagemakerDrafts = computeDrafts.filter((draft) => draft.serviceId === 'sagemaker-endpoint');
  const outside = [...sagemakerDrafts, ...externalDrafts];
  const outsideBlock = gridLayout(outside.map(leaf), 2);
  const outsideOrigin: Position = { x: vpcOrigin.x + vpcSize.width + 80, y: 40 };
  for (const entry of offset(outsideBlock.placed, outsideOrigin)) {
    if (nodes.some((node) => node.id === entry.item.id)) continue;
    emit(entry.item, entry.position);
  }

  // --- Edges: what talks to what ---------------------------------------------

  const link = (source: string, target: string, label?: string) => {
    const id = `edge-${source}-${target}`;
    if (edges.some((edge) => edge.id === id)) return;
    edges.push({ id, source, target, ...(label ? { label } : {}) });
  };

  for (const pair of frontendPairs) {
    link(pair.bucket.id, pair.cdn.id, 'origin');
  }

  if (albDraft) {
    for (const pair of frontendPairs) {
      link(pair.cdn.id, albDraft.id, 'API requests');
    }
  }

  for (const component of runnable) {
    const draft = computeByPath.get(component.path);
    if (!draft) continue;

    // Only request-serving components sit behind the load balancer. A worker
    // with a health check endpoint is still not something to route traffic to.
    if (
      albDraft &&
      component.kind !== 'worker' &&
      SERVING.some((c) => component.capabilities.includes(c))
    ) {
      link(albDraft.id, draft.id, 'HTTP');
    }

    for (const [capability, targets] of nodeForCapability) {
      if (!component.capabilities.includes(capability)) continue;
      for (const target of targets) {
        if (target.id === draft.id) continue;
        link(draft.id, target.id, capability);
      }
    }

    // A worker exists to consume the queue even when the queue was inferred
    // from its own dependency rather than named in its manifest.
    const queue = nodeForCapability.get('background-jobs')?.[0];
    if (queue && component.kind === 'worker') {
      link(draft.id, queue.id, 'consumes');
    }
  }

  // --- Remaining gaps ---------------------------------------------------------

  if (frontendPairs.length === 0 && frontends.length > 0) {
    gaps.push(
      'A front end was detected but no hosting node could be added, because the catalog is missing a service it needs.'
    );
  }

  for (const component of deployed) {
    if (component.kind !== 'unknown') continue;
    gaps.push(
      `${component.name} ships a container but nothing in its manifest says what it does, so it was proposed as a generic service. Set its role on the canvas.`
    );
  }

  return {
    name: `${repositoryName} architecture`,
    nodes,
    edges,
    decisions,
    gaps,
  };
}

export type { Placed };
