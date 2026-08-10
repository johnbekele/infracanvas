import { describe, expect, it } from 'vitest';
import { proposeArchitecture } from './architecture';
import {
  PROFILE_SCHEMA_VERSION,
  type AppProfile,
  type Capability,
  type DetectedDependency,
} from './profile';

function dependency(
  name: string,
  capability: Capability | null,
  sourcePath = 'package.json'
): DetectedDependency {
  return { name, ecosystem: 'npm', category: 'other', capability, sourcePath };
}

function profileWith(overrides: Partial<AppProfile> = {}): AppProfile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    commitSha: 'a'.repeat(40),
    ref: 'main',
    analysedAt: '2026-08-10T00:00:00.000Z',
    languages: [{ name: 'TypeScript', bytes: 1000, share: 1 }],
    components: [],
    dependencies: [],
    containerisation: { dockerfiles: [], composeFiles: [], exposedPorts: [] },
    fileCount: 10,
    totalBytes: 1000,
    notes: [],
    ...overrides,
  };
}

const serviceIdsOf = (proposal: { nodes: { serviceId: string }[] }) =>
  proposal.nodes.map((node) => node.serviceId);

describe('a repository with nothing to deploy', () => {
  it('proposes nothing and says why', () => {
    // Drawing an architecture for a library would present a guess as a
    // recommendation, which is worse than an empty canvas.
    const proposal = proposeArchitecture(profileWith(), 'some-library');

    expect(proposal.nodes).toEqual([]);
    expect(proposal.gaps[0]).toContain('does not appear to be a deployable application');
  });
});

describe('an HTTP service', () => {
  const httpProfile = profileWith({ dependencies: [dependency('express', 'http-server')] });

  it('places the load balancer in public and the compute in private', () => {
    const proposal = proposeArchitecture(httpProfile, 'billing-api');

    const alb = proposal.nodes.find((node) => node.serviceId === 'alb');
    const compute = proposal.nodes.find((node) => node.serviceId === 'ec2');
    const publicSubnet = proposal.nodes.find((node) => node.serviceId === 'public-subnet');
    const privateSubnet = proposal.nodes.find((node) => node.serviceId === 'private-subnet');

    expect(alb?.parentId).toBe(publicSubnet?.id);
    expect(compute?.parentId).toBe(privateSubnet?.id);
    expect(publicSubnet?.parentId).toBe('node-vpc');
  });

  it('routes traffic from the load balancer to the compute', () => {
    const proposal = proposeArchitecture(httpProfile, 'billing-api');

    expect(proposal.edges).toContainEqual(
      expect.objectContaining({ source: 'node-alb', target: 'node-compute' })
    );
  });

  it('chooses EC2 when there is no container image, and says what would change that', () => {
    const proposal = proposeArchitecture(httpProfile, 'billing-api');
    const decision = proposal.decisions.find((entry) => entry.nodeId === 'node-compute');

    expect(serviceIdsOf(proposal)).toContain('ec2');
    expect(decision?.rationale).toContain('Dockerfile');
  });

  it('chooses ECS when the repository builds a container image', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server')],
        containerisation: { dockerfiles: ['Dockerfile'], composeFiles: [], exposedPorts: [3000] },
      }),
      'billing-api'
    );

    const compute = proposal.nodes.find((node) => node.id === 'node-compute');

    expect(compute?.serviceId).toBe('ecs');
    // Taken from the EXPOSE directive rather than left at the catalog default.
    expect(compute?.properties.containerPort).toBe(3000);
  });

  it('leaves the container port alone when several are exposed, and says why', () => {
    // Choosing between 80 and 3001 with no basis would be a coin toss
    // presented to the user as a finding.
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server')],
        containerisation: {
          dockerfiles: ['apps/api/Dockerfile', 'apps/web/Dockerfile'],
          composeFiles: [],
          exposedPorts: [80, 3001],
        },
      }),
      'monorepo'
    );

    const compute = proposal.nodes.find((node) => node.id === 'node-compute');

    expect(compute?.properties.containerPort).toBe(80);
    expect(proposal.gaps.join(' ')).toContain('own port could not be determined');
  });

  it('says that a repository with several Dockerfiles gets only one compute node', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server')],
        containerisation: {
          dockerfiles: ['apps/api/Dockerfile', 'apps/web/Dockerfile'],
          composeFiles: [],
          exposedPorts: [3001],
        },
      }),
      'monorepo'
    );

    expect(proposal.gaps.join(' ')).toContain('more than one service');
  });

  it('names resources after the repository', () => {
    const proposal = proposeArchitecture(httpProfile, 'Billing API!');
    const vpc = proposal.nodes.find((node) => node.serviceId === 'vpc-environment');

    expect(vpc?.properties.vpcName).toBe('billing-api-vpc');
  });

  it('falls back to a usable name when nothing survives sanitising', () => {
    const proposal = proposeArchitecture(httpProfile, '!!!___!!!');
    const vpc = proposal.nodes.find((node) => node.serviceId === 'vpc-environment');

    expect(vpc?.properties.vpcName).toBe('app-vpc');
  });

  it('sanitises a long separator-heavy name without pathological backtracking', () => {
    // Trimming with `-+$` would retry from every position here; the assertion
    // that matters is that this returns at all, promptly.
    const started = Date.now();
    const proposal = proposeArchitecture(httpProfile, '-'.repeat(50_000));

    expect(Date.now() - started).toBeLessThan(1000);
    expect(
      proposal.nodes.find((node) => node.serviceId === 'vpc-environment')?.properties.vpcName
    ).toBe('app-vpc');
  });
});

describe('data stores', () => {
  it('adds RDS running Postgres for a Postgres client', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server'), dependency('pg', 'postgres')],
      }),
      'app'
    );

    const database = proposal.nodes.find((node) => node.id === 'node-database');

    expect(database?.serviceId).toBe('rds');
    expect(database?.properties.engine).toBe('postgres');
    expect(proposal.edges).toContainEqual(
      expect.objectContaining({ source: 'node-compute', target: 'node-database' })
    );
  });

  it('adds RDS running MySQL for a MySQL client', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server'), dependency('mysql2', 'mysql')],
      }),
      'app'
    );

    expect(proposal.nodes.find((node) => node.id === 'node-database')?.properties.engine).toBe(
      'mysql'
    );
  });

  it('adds ElastiCache for a Redis client', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server'), dependency('ioredis', 'redis')],
      }),
      'app'
    );

    expect(proposal.nodes.find((node) => node.id === 'node-cache')?.serviceId).toBe('elasticache');
  });

  it('adds no database when the only data dependency is an ORM', () => {
    // An ORM does not say which engine, and provisioning the wrong one is
    // worse than provisioning none.
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server'), dependency('prisma', null)],
      }),
      'app'
    );

    expect(serviceIdsOf(proposal)).not.toContain('rds');
  });

  it('does not place two databases when both Postgres and MySQL clients appear', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [
          dependency('express', 'http-server'),
          dependency('pg', 'postgres'),
          dependency('mysql2', 'mysql'),
        ],
      }),
      'app'
    );

    expect(proposal.nodes.filter((node) => node.serviceId === 'rds')).toHaveLength(1);
  });
});

describe('a frontend', () => {
  it('serves a static build from S3 behind CloudFront, outside any VPC', () => {
    const proposal = proposeArchitecture(
      profileWith({ dependencies: [dependency('react', 'frontend')] }),
      'marketing-site'
    );

    const bucket = proposal.nodes.find((node) => node.id === 'node-frontend-bucket');

    expect(bucket?.properties.staticHosting).toBe(true);
    expect(bucket?.parentId).toBeUndefined();
    expect(serviceIdsOf(proposal)).toContain('cloudfront');
    // Nothing runs, so there is no network to build.
    expect(serviceIdsOf(proposal)).not.toContain('vpc-environment');
  });

  it('connects the CDN to the load balancer when the repository serves both', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('react', 'frontend'), dependency('express', 'http-server')],
      }),
      'full-stack'
    );

    expect(proposal.edges).toContainEqual(
      expect.objectContaining({ source: 'node-frontend-cdn', target: 'node-alb' })
    );
  });
});

describe('capabilities with no service in the catalog', () => {
  it('reports MongoDB as a gap rather than substituting another database', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server'), dependency('mongoose', 'mongodb')],
      }),
      'app'
    );

    expect(serviceIdsOf(proposal)).not.toContain('dynamodb');
    expect(proposal.gaps.join(' ')).toContain('DocumentDB');
  });

  it('reports Kafka as a gap', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [dependency('express', 'http-server'), dependency('kafkajs', 'kafka')],
      }),
      'app'
    );

    expect(proposal.gaps.join(' ')).toContain('MSK');
  });
});

describe('decisions', () => {
  it('gives every node a decision that names the file behind it', () => {
    const proposal = proposeArchitecture(
      profileWith({
        dependencies: [
          dependency('express', 'http-server', 'services/api/package.json'),
          dependency('pg', 'postgres', 'services/api/package.json'),
        ],
      }),
      'app'
    );

    // Every node is explainable; a user can only reject a suggestion they can
    // see the reasoning for.
    for (const node of proposal.nodes) {
      expect(proposal.decisions.some((decision) => decision.nodeId === node.id)).toBe(true);
    }

    const database = proposal.decisions.find((decision) => decision.nodeId === 'node-database');
    expect(database?.evidence).toEqual(['services/api/package.json']);
  });

  it('is deterministic: the same profile yields the same proposal', () => {
    const built = () =>
      proposeArchitecture(
        profileWith({
          dependencies: [dependency('express', 'http-server'), dependency('pg', 'postgres')],
        }),
        'app'
      );

    expect(built()).toEqual(built());
  });
});
