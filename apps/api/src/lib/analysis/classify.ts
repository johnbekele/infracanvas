/**
 * Deciding what a component is for.
 *
 * The kind is what shapes the infrastructure proposed for a component, so it is
 * worth being explicit about: an API and a worker are both containers running
 * application code, and only one of them belongs behind a load balancer. Getting
 * this wrong does not produce a slightly worse diagram, it produces a worker
 * with a public endpoint.
 *
 * Every rule reads facts already extracted -- the path, the capabilities its own
 * manifests implied, whether a Dockerfile sits beside it -- so a classification
 * can be argued with by pointing at the evidence.
 */
import { isDeployableKind, type Capability, type ComponentKind } from '@infracanvas/core';

export interface ClassifyInput {
  /** Directory relative to the repository root, `.` at the root. */
  path: string;
  capabilities: Capability[];
  dockerfiles: string[];
  /** True when a compose service builds from this directory. */
  hasComposeService: boolean;
  /** The manifest declared itself a library, or is a workspace root. */
  libraryHint: boolean;
  /** Whether other components exist beneath this one. */
  hasNestedComponents: boolean;
}

/** Directory names whose contents are exercised, not deployed. */
const TEST_SEGMENTS = new Set([
  'test',
  'tests',
  '__tests__',
  'e2e',
  'spec',
  'specs',
  'integration-tests',
  'acceptance-tests',
  'load-tests',
  'regression-tests',
  'benchmarks',
]);

/** Directory names whose contents demonstrate rather than run. */
const EXAMPLE_SEGMENTS = new Set([
  'example',
  'examples',
  'sample',
  'samples',
  'poc',
  'pocs',
  'demo',
  'demos',
  'fixtures',
  'templates',
  '_templates',
  'scaffold',
  'skeleton',
  'storybook',
]);

/** Directory names that conventionally hold imported code rather than deployed code. */
const LIBRARY_SEGMENTS = new Set(['packages', 'libs', 'lib', 'shared', 'common', 'internal']);

function segments(path: string): string[] {
  return path === '.' ? [] : path.split('/');
}

function hasSegmentIn(path: string, names: Set<string>): boolean {
  return segments(path).some((segment) => names.has(segment.toLowerCase()));
}

const WORK_CAPABILITIES: Capability[] = [
  'background-jobs',
  'workflow-orchestration',
  'streaming',
  'kafka',
  'rabbitmq',
];

const SERVING_CAPABILITIES: Capability[] = [
  'http-server',
  'graphql',
  'grpc',
  'websocket',
  'mcp-server',
];

const MODEL_CAPABILITIES: Capability[] = [
  'ml-inference',
  'gpu-inference',
  'embeddings',
  'llm-api',
  'document-processing',
];

function includesAny(capabilities: Capability[], wanted: Capability[]): boolean {
  return wanted.some((capability) => capabilities.includes(capability));
}

/**
 * Classify a component.
 *
 * Order matters. Location is checked first because a FastAPI application under
 * `tests/` is a test harness however convincingly it resembles a service, and
 * proposing infrastructure for it is worse than ignoring it. Serving is checked
 * before model work because a service that both answers HTTP and runs inference
 * is an API that needs a GPU, not a model endpoint -- the distinction survives
 * on the component's capabilities, which synthesis reads separately.
 */
export function classifyComponent(input: ClassifyInput): ComponentKind {
  const { path, capabilities, dockerfiles, hasComposeService, libraryHint } = input;

  if (hasSegmentIn(path, TEST_SEGMENTS)) return 'test';
  if (hasSegmentIn(path, EXAMPLE_SEGMENTS)) return 'example';

  // A root manifest above other components is the workspace itself: it exists to
  // hold tooling and to list members, and deploying it would deploy everything
  // twice.
  if (path === '.' && input.hasNestedComponents && dockerfiles.length === 0) return 'library';

  const packaged = dockerfiles.length > 0 || hasComposeService;

  if (includesAny(capabilities, SERVING_CAPABILITIES)) return 'api';

  // A front end is deployable without a container: it builds to static files.
  if (capabilities.includes('frontend')) return 'frontend';

  if (includesAny(capabilities, WORK_CAPABILITIES) && packaged) return 'worker';
  if (capabilities.includes('scheduled-jobs') && packaged) return 'cron';
  if (includesAny(capabilities, MODEL_CAPABILITIES) && packaged) return 'ml-service';

  // Something is built here and nothing said what it serves. It runs, so it is a
  // worker: the alternative is dropping a container the repository clearly ships.
  if (packaged && !libraryHint) return 'worker';

  if (libraryHint || hasSegmentIn(path, LIBRARY_SEGMENTS)) return 'library';

  return 'unknown';
}

/**
 * Whether a component gets infrastructure of its own.
 *
 * A front end is deployable on the strength of being a front end, because its
 * artefact is a static bundle rather than an image. Everything else has to be
 * packaged: a directory with a web framework in its manifest and no Dockerfile
 * or compose service is a library that happens to include a test server.
 */
export function isDeployable(kind: ComponentKind, packaged: boolean): boolean {
  if (!isDeployableKind(kind)) return false;
  if (kind === 'frontend') return true;
  return packaged;
}
