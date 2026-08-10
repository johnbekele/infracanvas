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
 * Every node emitted carries a decision explaining why it is there and which
 * file in the repository put it there, because a user has to be able to reject
 * a suggestion, and they can only do that if they can see the reasoning.
 */
import { awsServices, type AWSService } from '../aws-services';
import { hasCapability, isContainerised, type AppProfile, type Capability } from './profile';

export interface ProposedNode {
  id: string;
  serviceId: string;
  /** Relative to `parentId` when nested, absolute otherwise, as React Flow expects. */
  position: { x: number; y: number };
  parentId?: string;
  size?: { width: number; height: number };
  properties: Record<string, string | number | boolean>;
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

/** Layout constants, chosen so nothing overlaps at the sizes the canvas renders. */
const LAYOUT = {
  vpc: { x: 420, y: 40, width: 940, height: 470 },
  publicSubnet: { x: 24, y: 76, width: 250, height: 360 },
  privateSubnet: { x: 300, y: 76, width: 610, height: 360 },
  /** Grid step inside a subnet. */
  cell: { width: 190, height: 150 },
  slotOrigin: { x: 26, y: 56 },
} as const;

function slot(index: number, columns: number): { x: number; y: number } {
  return {
    x: LAYOUT.slotOrigin.x + (index % columns) * LAYOUT.cell.width,
    y: LAYOUT.slotOrigin.y + Math.floor(index / columns) * LAYOUT.cell.height,
  };
}

/** Sanitises a repository name into something AWS accepts as a resource name. */
function resourceName(repositoryName: string, suffix: string): string {
  const base = repositoryName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

  return `${base || 'app'}-${suffix}`;
}

/** Capabilities with no service in this catalog, and what each would need. */
const GAP_MESSAGES: Partial<Record<Capability, string>> = {
  mongodb:
    'MongoDB was detected. The nearest managed service is DocumentDB, which is not in the service catalog yet, so no database node was added for it.',
  elasticsearch:
    'Elasticsearch was detected. OpenSearch Service would be the managed equivalent, but it is not in the service catalog yet.',
  kafka:
    'Kafka was detected. Amazon MSK would be the managed equivalent, but it is not in the service catalog yet.',
  rabbitmq:
    'RabbitMQ was detected. Amazon MQ would be the managed equivalent, but it is not in the service catalog yet.',
  email:
    'An email client was detected. Amazon SES would be the managed equivalent, but it is not in the service catalog yet.',
};

/** Paths of the manifests that provided a capability, for use as evidence. */
function evidenceFor(profile: AppProfile, capability: Capability): string[] {
  return [
    ...new Set(
      profile.dependencies
        .filter((dependency) => dependency.capability === capability)
        .map((dependency) => dependency.sourcePath)
    ),
  ];
}

function dependencyNames(profile: AppProfile, capability: Capability): string[] {
  return profile.dependencies
    .filter((dependency) => dependency.capability === capability)
    .map((dependency) => dependency.name);
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
  const nodes: ProposedNode[] = [];
  const edges: ProposedEdge[] = [];
  const decisions: ArchitectureDecision[] = [];
  const gaps: string[] = [];

  const add = (
    node: ProposedNode,
    decision: Omit<ArchitectureDecision, 'nodeId'>
  ): ProposedNode => {
    nodes.push(node);
    decisions.push({ nodeId: node.id, ...decision });
    return node;
  };

  const connect = (source: string, target: string, label?: string) => {
    edges.push({ id: `edge-${source}-${target}`, source, target, label });
  };

  const servesHttp = hasCapability(profile, 'http-server');
  const servesFrontend = hasCapability(profile, 'frontend');
  const containerised = isContainerised(profile);

  for (const [capability, message] of Object.entries(GAP_MESSAGES) as [Capability, string][]) {
    if (hasCapability(profile, capability)) gaps.push(message);
  }

  // A repository with no server and no frontend has nothing to deploy, and an
  // architecture drawn for it would be a guess presented as a recommendation.
  if (!servesHttp && !servesFrontend) {
    return {
      name: `${repositoryName} architecture`,
      nodes,
      edges,
      decisions,
      gaps: [
        'No web framework or frontend framework was found, so this repository does not appear to be a deployable application. Nothing was placed on the canvas.',
        ...gaps,
      ],
    };
  }

  // --- Static frontend, which lives outside the VPC entirely ---------------

  if (servesFrontend) {
    const bucket = add(
      {
        id: 'node-frontend-bucket',
        serviceId: 's3',
        position: { x: 40, y: 60 },
        properties: {
          ...defaultProperties('s3'),
          bucketName: resourceName(repositoryName, 'web'),
          staticHosting: true,
        },
      },
      {
        title: 'S3 bucket for the frontend build',
        rationale: `A frontend framework (${dependencyNames(profile, 'frontend').join(', ')}) builds to static files, which are served from object storage rather than from a running server.`,
        evidence: evidenceFor(profile, 'frontend'),
      }
    );

    const cdn = add(
      {
        id: 'node-frontend-cdn',
        serviceId: 'cloudfront',
        position: { x: 40, y: 230 },
        properties: defaultProperties('cloudfront'),
      },
      {
        title: 'CloudFront in front of the bucket',
        rationale:
          'Serving the bucket through a CDN terminates TLS, gives the site a custom domain, and puts the assets near users instead of in one region.',
        evidence: [],
      }
    );

    connect(bucket.id, cdn.id, 'origin');
  }

  // --- Everything that runs inside a network -------------------------------

  if (!servesHttp) {
    return { name: `${repositoryName} architecture`, nodes, edges, decisions, gaps };
  }

  const vpc = add(
    {
      id: 'node-vpc',
      serviceId: 'vpc-environment',
      position: { x: LAYOUT.vpc.x, y: LAYOUT.vpc.y },
      size: { width: LAYOUT.vpc.width, height: LAYOUT.vpc.height },
      properties: {
        ...defaultProperties('vpc-environment'),
        vpcName: resourceName(repositoryName, 'vpc'),
      },
    },
    {
      title: 'A VPC to hold the application',
      rationale:
        'The application serves HTTP and reaches data stores, so it needs a network it controls rather than being exposed directly.',
      evidence: [],
    }
  );

  const publicSubnet = add(
    {
      id: 'node-public-subnet',
      serviceId: 'public-subnet',
      position: { x: LAYOUT.publicSubnet.x, y: LAYOUT.publicSubnet.y },
      parentId: vpc.id,
      size: { width: LAYOUT.publicSubnet.width, height: LAYOUT.publicSubnet.height },
      properties: defaultProperties('public-subnet'),
    },
    {
      title: 'Public subnet for inbound traffic',
      rationale:
        'Only the load balancer needs to be reachable from the internet, so it gets its own subnet.',
      evidence: [],
    }
  );

  const privateSubnet = add(
    {
      id: 'node-private-subnet',
      serviceId: 'private-subnet',
      position: { x: LAYOUT.privateSubnet.x, y: LAYOUT.privateSubnet.y },
      parentId: vpc.id,
      size: { width: LAYOUT.privateSubnet.width, height: LAYOUT.privateSubnet.height },
      properties: defaultProperties('private-subnet'),
    },
    {
      title: 'Private subnet for the application and its data',
      rationale:
        'Compute and databases have no reason to accept connections from the internet, so they sit in a subnet with no route to it.',
      evidence: [],
    }
  );

  const loadBalancer = add(
    {
      id: 'node-alb',
      serviceId: 'alb',
      position: slot(0, 1),
      parentId: publicSubnet.id,
      properties: {
        ...defaultProperties('alb'),
        albName: resourceName(repositoryName, 'alb'),
        healthCheckPath: '/health',
      },
    },
    {
      title: 'Application Load Balancer',
      rationale:
        'An HTTP application needs a single stable entry point that terminates TLS and spreads requests across instances.',
      evidence: evidenceFor(profile, 'http-server'),
    }
  );

  // --- Compute -------------------------------------------------------------

  // Only used when it is unambiguous. A monorepo whose Dockerfiles expose 80
  // and 3001 gives no basis for choosing between them, and picking the lower
  // one would be a coin toss presented as a finding.
  const exposed = profile.containerisation.exposedPorts;
  const containerPort = exposed.length === 1 ? exposed[0] : undefined;

  const compute = containerised
    ? add(
        {
          id: 'node-compute',
          serviceId: 'ecs',
          position: slot(0, 3),
          parentId: privateSubnet.id,
          properties: {
            ...defaultProperties('ecs'),
            clusterName: resourceName(repositoryName, 'cluster'),
            serviceName: resourceName(repositoryName, 'service'),
            ...(containerPort ? { containerPort } : {}),
          },
        },
        {
          title: 'ECS on Fargate',
          rationale: `The repository already builds a container image (${profile.containerisation.dockerfiles[0]}), so it can run as a task without any change to how it is packaged.${
            containerPort
              ? ` The container port was taken from its EXPOSE directive (${containerPort}).`
              : ''
          }`,
          evidence: profile.containerisation.dockerfiles,
        }
      )
    : add(
        {
          id: 'node-compute',
          serviceId: 'ec2',
          position: slot(0, 3),
          parentId: privateSubnet.id,
          properties: defaultProperties('ec2'),
        },
        {
          title: 'EC2 instances',
          rationale:
            'The application serves HTTP but has no Dockerfile, so there is no container image to run. EC2 is the option that does not require repackaging first; adding a Dockerfile would make ECS on Fargate the better choice.',
          evidence: evidenceFor(profile, 'http-server'),
        }
      );

  connect(loadBalancer.id, compute.id, 'HTTP');

  // One compute node is proposed regardless of how many deployables the
  // repository holds. Saying so is better than drawing a single box and
  // letting it be mistaken for the whole picture.
  if (profile.containerisation.dockerfiles.length > 1) {
    gaps.push(
      `This repository has ${profile.containerisation.dockerfiles.length} Dockerfiles, so it likely deploys more than one service. A single compute node was proposed; splitting it per service is something to do on the canvas.`
    );
  }

  if (exposed.length > 1) {
    gaps.push(
      `Several container ports are exposed (${exposed.join(', ')}), so the application's own port could not be determined. The compute node was left at the default.`
    );
  }

  // The frontend calls the API, which is why both exist in one diagram.
  if (servesFrontend) {
    connect('node-frontend-cdn', loadBalancer.id, 'API requests');
  }

  // --- Data stores ---------------------------------------------------------

  let dataSlot = 1;
  const nextDataSlot = () => slot(dataSlot++, 3);

  const relational: { capability: Capability; engine: string; label: string } | null =
    hasCapability(profile, 'postgres')
      ? { capability: 'postgres', engine: 'postgres', label: 'PostgreSQL' }
      : hasCapability(profile, 'mysql')
        ? { capability: 'mysql', engine: 'mysql', label: 'MySQL' }
        : null;

  if (relational) {
    const database = add(
      {
        id: 'node-database',
        serviceId: 'rds',
        position: nextDataSlot(),
        parentId: privateSubnet.id,
        properties: {
          ...defaultProperties('rds'),
          identifier: resourceName(repositoryName, 'db'),
          engine: relational.engine,
        },
      },
      {
        title: `RDS running ${relational.label}`,
        rationale: `A ${relational.label} client (${dependencyNames(profile, relational.capability).join(', ')}) is a direct dependency, so the application expects a ${relational.label} server it can connect to.`,
        evidence: evidenceFor(profile, relational.capability),
      }
    );

    connect(compute.id, database.id, relational.label);
  }

  if (hasCapability(profile, 'redis')) {
    const cache = add(
      {
        id: 'node-cache',
        serviceId: 'elasticache',
        position: nextDataSlot(),
        parentId: privateSubnet.id,
        properties: {
          ...defaultProperties('elasticache'),
          clusterId: resourceName(repositoryName, 'cache'),
          engine: 'redis',
        },
      },
      {
        title: 'ElastiCache running Redis',
        rationale: `A Redis client (${dependencyNames(profile, 'redis').join(', ')}) is a direct dependency.${
          hasCapability(profile, 'background-jobs')
            ? ' It also backs the job queue found in this repository, so it holds state that cannot be lost on restart.'
            : ''
        }`,
        evidence: evidenceFor(profile, 'redis'),
      }
    );

    connect(compute.id, cache.id, 'Redis');
  }

  // --- Outside the VPC -----------------------------------------------------

  if (hasCapability(profile, 'object-storage')) {
    const bucket = add(
      {
        id: 'node-object-storage',
        serviceId: 's3',
        position: { x: 1420, y: 60 },
        properties: {
          ...defaultProperties('s3'),
          bucketName: resourceName(repositoryName, 'data'),
        },
      },
      {
        title: 'S3 bucket for application data',
        rationale:
          'The application uses an object storage client, so it reads or writes files it expects to outlive any one instance.',
        evidence: evidenceFor(profile, 'object-storage'),
      }
    );

    connect(compute.id, bucket.id, 'objects');
  }

  if (hasCapability(profile, 'background-jobs')) {
    const queue = add(
      {
        id: 'node-queue',
        serviceId: 'sqs',
        position: { x: 1420, y: 230 },
        properties: defaultProperties('sqs'),
      },
      {
        title: 'SQS queue for background work',
        rationale: `A job library (${dependencyNames(profile, 'background-jobs').join(', ')}) is a direct dependency, so work is handled outside the request path. SQS is the managed option; keeping the existing library on ElastiCache is the alternative if its scheduling features are in use.`,
        evidence: evidenceFor(profile, 'background-jobs'),
      }
    );

    connect(compute.id, queue.id, 'jobs');
  }

  return { name: `${repositoryName} architecture`, nodes, edges, decisions, gaps };
}
