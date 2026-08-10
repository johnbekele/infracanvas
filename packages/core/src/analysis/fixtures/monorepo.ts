/**
 * A profile shaped like a real monorepo.
 *
 * Modelled on the kind of repository the previous engine collapsed into one ECS
 * box: several HTTP services, workers that must stay off the load balancer path,
 * a front end, a model service, two distinct databases declared in compose, and
 * directories that look deployable but are tests and examples.
 *
 * Kept as a fixture rather than inlined in one test so that every rule is
 * exercised against the same repository, and a change that fixes one service by
 * breaking another shows up immediately.
 */
import {
  PROFILE_SCHEMA_VERSION,
  type AppProfile,
  type Capability,
  type Component,
  type ComponentKind,
  type ComposeService,
  type DetectedDependency,
  type Ecosystem,
} from '../profile';

export function dependency(
  name: string,
  capability: Capability | null,
  sourcePath: string,
  ecosystem: Ecosystem = 'npm'
): DetectedDependency {
  return { name, ecosystem, category: 'other', capability, sourcePath };
}

export interface ComponentOptions {
  path: string;
  name?: string;
  kind: ComponentKind;
  capabilities?: Capability[];
  dependencies?: DetectedDependency[];
  dockerfiles?: string[];
  exposedPorts?: number[];
  composeService?: string | null;
  deployable?: boolean;
  ecosystem?: Ecosystem;
}

export function component(options: ComponentOptions): Component {
  const manifestPath =
    options.path === '.' ? 'package.json' : `${options.path}/${manifestFor(options.ecosystem)}`;

  const dependencies =
    options.dependencies ??
    (options.capabilities ?? []).map((capability) =>
      dependency(capability, capability, manifestPath, options.ecosystem ?? 'npm')
    );

  return {
    path: options.path,
    name: options.name ?? options.path.split('/').pop() ?? options.path,
    kind: options.kind,
    ecosystems: [options.ecosystem ?? 'npm'],
    manifestPaths: [manifestPath],
    dependencyCount: dependencies.length,
    capabilities:
      options.capabilities ??
      [...new Set(dependencies.map((entry) => entry.capability))].filter(
        (capability): capability is Capability => capability !== null
      ),
    dependencies,
    dockerfiles: options.dockerfiles ?? [],
    exposedPorts: options.exposedPorts ?? [],
    composeService: options.composeService ?? null,
    deployable: options.deployable ?? true,
  };
}

function manifestFor(ecosystem: Ecosystem = 'npm'): string {
  return ecosystem === 'pypi' ? 'pyproject.toml' : 'package.json';
}

export function composeService(
  name: string,
  overrides: Partial<ComposeService> = {}
): ComposeService {
  return {
    name,
    file: 'docker-compose.yml',
    buildContext: null,
    image: null,
    capability: null,
    ports: [],
    dependsOn: [],
    ...overrides,
  };
}

/**
 * A profile with sensible defaults.
 *
 * The repository-wide rollup is derived from the components rather than taken
 * separately, because that is what the analyser does. A fixture where the two
 * disagree tests a profile that cannot exist, and the resulting failure points
 * at the engine rather than at the fixture.
 */
export function profileWith(overrides: Partial<AppProfile> = {}): AppProfile {
  const components = overrides.components ?? [];

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    commitSha: 'a'.repeat(40),
    ref: 'main',
    analysedAt: '2026-08-10T00:00:00.000Z',
    languages: [{ name: 'TypeScript', bytes: 1000, share: 1 }],
    components: [],
    composeServices: [],
    containerisation: { dockerfiles: [], composeFiles: [], exposedPorts: [] },
    fileCount: 10,
    totalBytes: 1000,
    notes: [],
    ...overrides,
    dependencies: overrides.dependencies ?? rollup(components),
  };
}

/** Roll the per-component dependencies up the way the analyser does. */
function rollup(components: Component[]): DetectedDependency[] {
  const seen = new Set<string>();
  const all: DetectedDependency[] = [];

  for (const item of components) {
    for (const entry of item.dependencies) {
      const key = `${entry.ecosystem}:${entry.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(entry);
    }
  }

  return all;
}

const COMPONENTS: Component[] = [
  component({
    path: '.',
    name: 'platform',
    kind: 'library',
    capabilities: [],
    deployable: false,
  }),
  component({
    path: 'apps/api',
    kind: 'api',
    ecosystem: 'pypi',
    dependencies: [
      dependency('fastapi', 'http-server', 'apps/api/pyproject.toml', 'pypi'),
      dependency('asyncpg', 'postgres', 'apps/api/pyproject.toml', 'pypi'),
      dependency('redis', 'redis', 'apps/api/pyproject.toml', 'pypi'),
    ],
    dockerfiles: ['apps/api/Dockerfile'],
    exposedPorts: [8000],
    composeService: 'api',
  }),
  component({
    path: 'apps/chat',
    kind: 'api',
    ecosystem: 'pypi',
    dependencies: [
      dependency('fastapi', 'http-server', 'apps/chat/pyproject.toml', 'pypi'),
      dependency('openai', 'llm-api', 'apps/chat/pyproject.toml', 'pypi'),
      dependency('qdrant-client', 'vector-search', 'apps/chat/pyproject.toml', 'pypi'),
    ],
    dockerfiles: ['apps/chat/Dockerfile'],
    exposedPorts: [8001],
    composeService: 'chat',
  }),
  component({
    path: 'apps/mcp',
    kind: 'api',
    ecosystem: 'pypi',
    dependencies: [dependency('fastmcp', 'mcp-server', 'apps/mcp/pyproject.toml', 'pypi')],
    dockerfiles: ['apps/mcp/Dockerfile'],
    exposedPorts: [9000],
  }),
  component({
    path: 'apps/profiles-worker',
    kind: 'worker',
    ecosystem: 'pypi',
    dependencies: [
      dependency('celery', 'background-jobs', 'apps/profiles-worker/pyproject.toml', 'pypi'),
      dependency('asyncpg', 'postgres', 'apps/profiles-worker/pyproject.toml', 'pypi'),
    ],
    dockerfiles: ['apps/profiles-worker/Dockerfile'],
    composeService: 'profiles-worker',
  }),
  component({
    path: 'apps/document-processor',
    kind: 'worker',
    ecosystem: 'pypi',
    dependencies: [
      dependency('celery', 'background-jobs', 'apps/document-processor/pyproject.toml', 'pypi'),
      dependency(
        'unstructured',
        'document-processing',
        'apps/document-processor/pyproject.toml',
        'pypi'
      ),
      dependency('boto3', 'object-storage', 'apps/document-processor/pyproject.toml', 'pypi'),
    ],
    dockerfiles: ['apps/document-processor/Dockerfile'],
  }),
  component({
    path: 'apps/embedder',
    kind: 'ml-service',
    ecosystem: 'pypi',
    dependencies: [
      dependency('torch', 'gpu-inference', 'apps/embedder/pyproject.toml', 'pypi'),
      dependency('sentence-transformers', 'embeddings', 'apps/embedder/pyproject.toml', 'pypi'),
    ],
    dockerfiles: ['apps/embedder/Dockerfile'],
  }),
  component({
    path: 'apps/dashboard',
    kind: 'frontend',
    capabilities: ['frontend'],
  }),
  component({
    path: 'apps/landing',
    kind: 'frontend',
    capabilities: ['frontend'],
  }),
  component({
    path: 'packages/shared',
    kind: 'library',
    capabilities: [],
    deployable: false,
  }),
  component({
    path: 'tests/e2e',
    kind: 'test',
    capabilities: ['http-server'],
    deployable: false,
  }),
  component({
    path: 'examples/quickstart',
    kind: 'example',
    capabilities: ['http-server'],
    deployable: false,
  }),
];

/**
 * The whole repository: six deployable services, two front ends, two databases
 * named in compose, and three directories that must not be deployed.
 */
export const MONOREPO: AppProfile = profileWith({
  components: COMPONENTS,
  dependencies: rollup(COMPONENTS),
  composeServices: [
    composeService('api', { buildContext: 'apps/api', ports: [8000] }),
    composeService('chat', { buildContext: 'apps/chat', ports: [8001] }),
    composeService('profiles-worker', { buildContext: 'apps/profiles-worker' }),
    composeService('primary-db', { image: 'postgres:16', capability: 'postgres', ports: [5432] }),
    composeService('analytics-db', { image: 'postgres:16', capability: 'postgres', ports: [5432] }),
    composeService('cache', { image: 'redis:7', capability: 'redis', ports: [6379] }),
  ],
  containerisation: {
    dockerfiles: COMPONENTS.flatMap((item) => item.dockerfiles),
    composeFiles: ['docker-compose.yml'],
    exposedPorts: [8000, 8001, 9000],
  },
});
