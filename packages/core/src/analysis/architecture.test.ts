import { describe, expect, it } from 'vitest';
import { proposeArchitecture, resourceName, type ArchitectureProposal } from './architecture';
import { MONOREPO, component, composeService, dependency, profileWith } from './fixtures/monorepo';
import { NODE_SIZE } from './layout';

const nodeFor = (proposal: ArchitectureProposal, componentPath: string) =>
  proposal.nodes.find((node) => node.componentPath === componentPath);

const serviceIdsOf = (proposal: ArchitectureProposal) =>
  proposal.nodes.map((node) => node.serviceId);

const hasEdge = (proposal: ArchitectureProposal, source: string, target: string) =>
  proposal.edges.some((edge) => edge.source === source && edge.target === target);

const edgeBetween = (proposal: ArchitectureProposal, source: string, target: string) =>
  proposal.edges.find((edge) => edge.source === source && edge.target === target);

describe('a repository with nothing to deploy', () => {
  it('proposes nothing and says why', () => {
    // Drawing an architecture for a library would present a guess as a
    // recommendation, which is worse than an empty canvas.
    const proposal = proposeArchitecture(profileWith(), 'some-library');

    expect(proposal.nodes).toEqual([]);
    expect(proposal.gaps[0]).toContain('No deployable component was found');
  });
});

describe('a monorepo with several services', () => {
  const proposal = proposeArchitecture(MONOREPO, 'platform');

  it('emits one compute node per deployable component', () => {
    const paths = proposal.nodes
      .filter((node) => node.componentPath !== undefined && node.serviceId !== 's3')
      .map((node) => node.componentPath);

    for (const path of [
      'apps/api',
      'apps/chat',
      'apps/mcp',
      'apps/profiles-worker',
      'apps/document-processor',
      'apps/embedder',
    ]) {
      expect(paths).toContain(path);
    }
  });

  it('does not deploy tests, examples, or libraries', () => {
    const paths = proposal.nodes.map((node) => node.componentPath);

    expect(paths).not.toContain('tests/e2e');
    expect(paths).not.toContain('examples/quickstart');
    expect(paths).not.toContain('packages/shared');
  });

  it('keeps workers off the load balancer path', () => {
    const alb = proposal.nodes.find((node) => node.serviceId === 'alb');
    const worker = nodeFor(proposal, 'apps/profiles-worker');

    expect(alb).toBeDefined();
    expect(worker).toBeDefined();
    expect(hasEdge(proposal, alb!.id, worker!.id)).toBe(false);
  });

  it('routes requests to each service that answers them', () => {
    const alb = proposal.nodes.find((node) => node.serviceId === 'alb');

    for (const path of ['apps/api', 'apps/chat', 'apps/mcp']) {
      expect(hasEdge(proposal, alb!.id, nodeFor(proposal, path)!.id)).toBe(true);
    }
  });

  it('connects a worker to the queue it consumes', () => {
    const queue = proposal.nodes.find((node) => node.serviceId === 'sqs');
    const worker = nodeFor(proposal, 'apps/profiles-worker');

    expect(queue).toBeDefined();
    expect(hasEdge(proposal, worker!.id, queue!.id)).toBe(true);
  });

  it('emits a bucket and distribution per front end', () => {
    const buckets = proposal.nodes.filter((node) => node.id.startsWith('frontend-bucket-'));
    const distributions = proposal.nodes.filter((node) => node.id.startsWith('frontend-cdn-'));

    expect(buckets).toHaveLength(2);
    expect(distributions).toHaveLength(2);
    expect(hasEdge(proposal, buckets[0].id, distributions[0].id)).toBe(true);
  });

  it('emits one database per distinct relational compose service', () => {
    const databases = proposal.nodes.filter((node) => node.serviceId === 'rds');

    expect(databases).toHaveLength(2);
    expect(databases.every((node) => node.confidence === 'high')).toBe(true);
  });

  it('nests compute inside a cluster inside a private subnet', () => {
    const api = nodeFor(proposal, 'apps/api');
    const cluster = proposal.nodes.find((node) => node.serviceId === 'ecs-cluster');
    const privateSubnet = proposal.nodes.find((node) => node.serviceId === 'private-subnet');
    const vpc = proposal.nodes.find((node) => node.serviceId === 'vpc-environment');

    expect(api?.parentId).toBe(cluster?.id);
    expect(cluster?.parentId).toBe(privateSubnet?.id);
    expect(privateSubnet?.parentId).toBe(vpc?.id);
    expect(vpc?.parentId).toBeUndefined();
  });

  it('grows the cluster to fit every service it holds', () => {
    const cluster = proposal.nodes.find((node) => node.serviceId === 'ecs-cluster');
    const children = proposal.nodes.filter((node) => node.parentId === cluster?.id);

    for (const child of children) {
      expect(child.position.x + NODE_SIZE.width).toBeLessThanOrEqual(cluster!.size!.width);
      expect(child.position.y + NODE_SIZE.height).toBeLessThanOrEqual(cluster!.size!.height);
    }
  });

  it('does not overlap two nodes in the same container', () => {
    const cluster = proposal.nodes.find((node) => node.serviceId === 'ecs-cluster');
    const children = proposal.nodes.filter((node) => node.parentId === cluster?.id);

    for (const a of children) {
      for (const b of children) {
        if (a.id === b.id) continue;
        const separated =
          Math.abs(a.position.x - b.position.x) >= NODE_SIZE.width ||
          Math.abs(a.position.y - b.position.y) >= NODE_SIZE.height;
        expect(separated).toBe(true);
      }
    }
  });

  it('gives every node a decision and a confidence', () => {
    for (const node of proposal.nodes) {
      const decision = proposal.decisions.find((entry) => entry.nodeId === node.id);
      expect(decision, `no decision for ${node.id}`).toBeDefined();
      expect(decision?.confidence).toBe(node.confidence);
    }
  });

  it('cites the manifest behind each service it proposes', () => {
    expect(nodeFor(proposal, 'apps/api')?.evidence).toContain('apps/api/pyproject.toml');
    expect(nodeFor(proposal, 'apps/api')?.evidence).toContain('apps/api/Dockerfile');
  });

  it('is deterministic: the same profile yields the same proposal', () => {
    const again = proposeArchitecture(MONOREPO, 'platform');
    expect(JSON.stringify(again)).toEqual(JSON.stringify(proposal));
  });

  it('proposes managed services for the AI dependencies it found', () => {
    const ids = serviceIdsOf(proposal);

    // A third-party model API needs its key stored, whatever else is proposed.
    expect(ids).toContain('secrets-manager');
    expect(ids).toContain('opensearch-vector');
    expect(ids).toContain('textract');
  });

  it('marks an AWS substitution as low confidence', () => {
    const bedrock = proposal.nodes.find((node) => node.serviceId === 'bedrock');

    expect(bedrock?.confidence).toBe('low');
    expect(proposal.decisions.find((entry) => entry.nodeId === bedrock?.id)?.rationale).toContain(
      'substitution'
    );
  });
});

describe('a repository that declares its own topology', () => {
  // Two services, two databases, and a compose file that says which service
  // opens which. Capability overlap alone cannot tell them apart: both declare
  // the same Postgres driver.
  const profile = profileWith({
    components: [
      component({
        path: 'apps/billing',
        kind: 'api',
        dependencies: [
          dependency('express', 'http-server', 'apps/billing/package.json'),
          dependency('pg', 'postgres', 'apps/billing/package.json'),
          dependency('@aws-sdk/client-s3', 'object-storage', 'apps/billing/package.json'),
        ],
        dockerfiles: ['apps/billing/Dockerfile'],
        composeService: 'billing',
      }),
      component({
        path: 'apps/reports',
        kind: 'api',
        dependencies: [
          dependency('express', 'http-server', 'apps/reports/package.json'),
          dependency('pg', 'postgres', 'apps/reports/package.json'),
        ],
        dockerfiles: ['apps/reports/Dockerfile'],
        composeService: 'reports',
      }),
    ],
    composeServices: [
      composeService('billing', {
        buildContext: 'apps/billing',
        dependsOn: ['billing-db', 'cache'],
      }),
      composeService('reports', { buildContext: 'apps/reports', dependsOn: ['analytics-db'] }),
      composeService('billing-db', { image: 'postgres:16', capability: 'postgres' }),
      composeService('analytics-db', { image: 'postgres:16', capability: 'postgres' }),
      composeService('cache', { image: 'redis:7', capability: 'redis' }),
    ],
  });

  const proposal = proposeArchitecture(profile, 'ledger');
  const billing = nodeFor(proposal, 'apps/billing')!;
  const reports = nodeFor(proposal, 'apps/reports')!;
  const billingDb = proposal.nodes.find((node) => node.id === 'database-billing-db')!;
  const analyticsDb = proposal.nodes.find((node) => node.id === 'database-analytics-db')!;

  it('draws the edge the compose file declares', () => {
    expect(hasEdge(proposal, billing.id, billingDb.id)).toBe(true);
    expect(hasEdge(proposal, reports.id, analyticsDb.id)).toBe(true);
  });

  it('marks a declared edge as declared', () => {
    const edge = edgeBetween(proposal, billing.id, billingDb.id);

    expect(edge?.origin).toBe('declared');
    expect(edge?.label).toBe('depends_on');
  });

  it('does not guess the connection the declaration leaves out', () => {
    // Capability overlap would wire both services to both databases. The
    // repository already said which one each of them opens.
    expect(hasEdge(proposal, billing.id, analyticsDb.id)).toBe(false);
    expect(hasEdge(proposal, reports.id, billingDb.id)).toBe(false);
  });

  it('resolves a declaration onto the node that replaced the container', () => {
    const cache = proposal.nodes.find((node) => node.serviceId === 'elasticache')!;

    expect(edgeBetween(proposal, billing.id, cache.id)?.origin).toBe('declared');
  });

  it('still infers a connection to a service compose cannot name', () => {
    // A bucket is not a compose service, so declaring `depends_on` says nothing
    // about it and the inferred edge has to survive.
    const bucket = proposal.nodes.find((node) => node.id === 'storage-objects')!;
    const edge = edgeBetween(proposal, billing.id, bucket.id);

    expect(edge?.origin).toBe('inferred');
  });

  it('reports a declared dependency it could not draw', () => {
    const withUnknown = profileWith({
      ...profile,
      composeServices: [
        composeService('billing', { buildContext: 'apps/billing', dependsOn: ['telemetry'] }),
        composeService('telemetry', { image: 'acme/in-house-collector' }),
      ],
    });

    const gaps = proposeArchitecture(withUnknown, 'ledger').gaps;

    expect(gaps.some((gap) => gap.includes('depends on telemetry'))).toBe(true);
  });

  it('says nothing about a dependency naming a service compose never declared', () => {
    // An override file this analysis did not read, or a typo. Either way there is
    // no dropped dependency to report.
    const withGhost = profileWith({
      ...profile,
      composeServices: [
        composeService('billing', { buildContext: 'apps/billing', dependsOn: ['ghost'] }),
      ],
    });

    const gaps = proposeArchitecture(withGhost, 'ledger').gaps;

    expect(gaps.some((gap) => gap.includes('ghost'))).toBe(false);
  });
});

describe('a repository that declares nothing', () => {
  // The compose services in this fixture carry no `depends_on`, so the overlap
  // heuristic is all there is, and it has to keep working.
  const proposal = proposeArchitecture(MONOREPO, 'platform');

  it('falls back to capability overlap', () => {
    const api = nodeFor(proposal, 'apps/api')!;
    const databases = proposal.nodes.filter((node) => node.serviceId === 'rds');

    expect(databases).toHaveLength(2);
    for (const database of databases) {
      expect(hasEdge(proposal, api.id, database.id)).toBe(true);
    }
  });

  it('marks every edge it guessed as inferred', () => {
    expect(proposal.edges.length).toBeGreaterThan(0);
    expect(proposal.edges.every((edge) => edge.origin === 'inferred')).toBe(true);
  });
});

describe('inferring a database without compose', () => {
  const profile = profileWith({
    components: [
      component({
        path: 'apps/api',
        kind: 'api',
        dependencies: [
          dependency('express', 'http-server', 'apps/api/package.json'),
          dependency('pg', 'postgres', 'apps/api/package.json'),
        ],
        dockerfiles: ['apps/api/Dockerfile'],
      }),
      component({
        path: 'apps/admin',
        kind: 'api',
        dependencies: [
          dependency('express', 'http-server', 'apps/admin/package.json'),
          dependency('pg', 'postgres', 'apps/admin/package.json'),
        ],
        dockerfiles: ['apps/admin/Dockerfile'],
      }),
    ],
    dependencies: [dependency('pg', 'postgres', 'apps/api/package.json')],
  });

  it('falls back to a single shared database', () => {
    const proposal = proposeArchitecture(profile, 'billing');
    const databases = proposal.nodes.filter((node) => node.serviceId === 'rds');

    expect(databases).toHaveLength(1);
  });

  it('marks a driver-derived database as medium confidence', () => {
    const proposal = proposeArchitecture(profile, 'billing');
    const database = proposal.nodes.find((node) => node.serviceId === 'rds');

    expect(database?.confidence).toBe('medium');
  });

  it('connects every component that declared the driver', () => {
    const proposal = proposeArchitecture(profile, 'billing');
    const database = proposal.nodes.find((node) => node.serviceId === 'rds');

    expect(hasEdge(proposal, nodeFor(proposal, 'apps/api')!.id, database!.id)).toBe(true);
    expect(hasEdge(proposal, nodeFor(proposal, 'apps/admin')!.id, database!.id)).toBe(true);
  });
});

describe('vector search', () => {
  it('rides on the relational instance when pgvector is the only signal', () => {
    const profile = profileWith({
      components: [
        component({
          path: 'apps/api',
          kind: 'api',
          dependencies: [
            dependency('express', 'http-server', 'apps/api/package.json'),
            dependency('pg', 'postgres', 'apps/api/package.json'),
            dependency('pgvector', 'vector-search', 'apps/api/package.json'),
          ],
          dockerfiles: ['apps/api/Dockerfile'],
        }),
      ],
    });

    const proposal = proposeArchitecture(profile, 'rag');
    const database = proposal.nodes.find((node) => node.serviceId === 'rds');

    expect(serviceIdsOf(proposal)).not.toContain('opensearch-vector');
    expect(proposal.decisions.find((entry) => entry.nodeId === database?.id)?.rationale).toContain(
      'pgvector'
    );
  });
});

describe('a component that ships no container', () => {
  it('is proposed on EC2 and says why', () => {
    const profile = profileWith({
      components: [
        component({
          path: '.',
          name: 'server',
          kind: 'api',
          dependencies: [dependency('express', 'http-server', 'package.json')],
        }),
      ],
    });

    const proposal = proposeArchitecture(profile, 'server');
    const compute = proposal.nodes.find((node) => node.serviceId === 'ec2');

    expect(compute).toBeDefined();
    expect(compute?.confidence).toBe('medium');
    expect(proposal.decisions.find((entry) => entry.nodeId === compute?.id)?.rationale).toContain(
      'Dockerfile'
    );
  });
});

describe('capabilities the catalog cannot express', () => {
  it('reports ClickHouse as a substitution rather than a silent match', () => {
    const profile = profileWith({
      components: [
        component({
          path: 'apps/api',
          kind: 'api',
          dependencies: [
            dependency('express', 'http-server', 'apps/api/package.json'),
            dependency('@clickhouse/client', 'clickhouse', 'apps/api/package.json'),
          ],
          dockerfiles: ['apps/api/Dockerfile'],
        }),
      ],
    });

    const proposal = proposeArchitecture(profile, 'events');
    const warehouse = proposal.nodes.find((node) => node.serviceId === 'redshift');

    expect(proposal.decisions.find((entry) => entry.nodeId === warehouse?.id)?.rationale).toContain(
      'dialect differs'
    );
  });

  it('reports a capability with no catalog service as a gap', () => {
    const profile = profileWith({
      components: [
        component({
          path: 'apps/api',
          kind: 'api',
          dependencies: [
            dependency('express', 'http-server', 'apps/api/package.json'),
            dependency('feast', 'feature-store', 'apps/api/package.json'),
          ],
          dockerfiles: ['apps/api/Dockerfile'],
        }),
      ],
      composeServices: [composeService('api', { buildContext: 'apps/api' })],
    });

    const proposal = proposeArchitecture(profile, 'features');

    // Nothing in the catalog covers a feature store yet, and inventing a node
    // for it would be worse than saying so.
    expect(serviceIdsOf(proposal)).not.toContain('feature-store');
  });
});

describe('resource names', () => {
  it('strips characters AWS will not accept', () => {
    expect(resourceName('My Repo!', 'db')).toBe('my-repo-db');
  });

  it('does not leave a leading or trailing separator', () => {
    expect(resourceName('---', 'db')).toBe('app-db');
    expect(resourceName('.hidden.', 'vpc')).toBe('hidden-vpc');
  });
});
