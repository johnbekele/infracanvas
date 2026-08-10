/**
 * The application profile: what a repository is, expressed in terms that an
 * infrastructure decision can be made from.
 *
 * Everything here is derived deterministically from files in the repository --
 * dependency manifests, Dockerfiles, compose files -- rather than inferred by a
 * model. That matters because the profile is the input to architecture
 * selection, and a hallucinated dependency becomes a provisioned database. Each
 * finding therefore carries the path it was read from, so any claim can be
 * checked against the source.
 *
 * Findings are attributed to the component that declared them. A repository-wide
 * list can only say "something here uses Postgres", which is enough to draw one
 * database and nothing else; knowing that three of seven services use it is what
 * makes the difference between a diagram and an architecture.
 */

/**
 * Version 2 attributes dependencies to components and reads compose topology.
 * A version 1 profile is not upgraded in place: it was built without the data,
 * and inventing the missing attribution would defeat the point of recording it.
 */
export const PROFILE_SCHEMA_VERSION = 2;

/** Package ecosystems whose manifests are understood. */
export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo' | 'maven' | 'rubygems' | 'composer';

/**
 * What a dependency implies about the infrastructure a component needs.
 *
 * Deliberately coarse. `postgres` is a capability because it maps to a managed
 * service; `pg` versus `postgres.js` is a library choice that changes nothing
 * about what has to be provisioned.
 */
export type Capability =
  // How the component is reached.
  | 'http-server'
  | 'graphql'
  | 'grpc'
  | 'websocket'
  | 'frontend'
  | 'mcp-server'
  // What it stores state in.
  | 'postgres'
  | 'mysql'
  | 'mongodb'
  | 'redis'
  | 'dynamodb'
  | 'cassandra'
  | 'clickhouse'
  | 'graph-db'
  | 'elasticsearch'
  | 'vector-search'
  // How work moves between components.
  | 'kafka'
  | 'rabbitmq'
  | 'background-jobs'
  | 'scheduled-jobs'
  | 'streaming'
  | 'workflow-orchestration'
  // What it needs to run a model.
  | 'llm-api'
  | 'embeddings'
  | 'ml-inference'
  | 'gpu-inference'
  | 'document-processing'
  | 'feature-store'
  // Everything else that has to be provisioned.
  | 'object-storage'
  | 'email'
  | 'identity'
  | 'observability'
  | 'secrets';

/**
 * How a dependency was classified. `orm` is separate from a datastore
 * capability on purpose: an ORM says data is stored relationally but not in
 * which engine, and guessing the engine is how the wrong database gets
 * provisioned.
 */
export type DependencyCategory =
  | 'web-framework'
  | 'frontend-framework'
  | 'datastore'
  | 'cache'
  | 'queue'
  | 'search'
  | 'vector'
  | 'orm'
  | 'cloud-sdk'
  | 'ml'
  | 'llm'
  | 'agent'
  | 'document'
  | 'workflow'
  | 'observability'
  | 'auth'
  | 'other';

/**
 * The role a component plays, which is what decides the shape of the
 * infrastructure proposed for it. A worker and an API are both containers
 * running application code; only one of them belongs behind a load balancer.
 */
export type ComponentKind =
  | 'api'
  | 'worker'
  | 'frontend'
  | 'ml-service'
  | 'cron'
  | 'library'
  | 'test'
  | 'example'
  | 'unknown';

export interface LanguageBreakdown {
  name: string;
  bytes: number;
  /** Fraction of all classified bytes, 0 to 1. */
  share: number;
}

export interface DetectedDependency {
  name: string;
  ecosystem: Ecosystem;
  category: DependencyCategory;
  /** Null when the dependency is recognised but implies no specific infrastructure. */
  capability: Capability | null;
  /** The file this was read from, so the finding can be checked. */
  sourcePath: string;
}

/**
 * One directory that holds application code, not one manifest.
 *
 * A service written in Python with a JavaScript front end has a `pyproject.toml`
 * and a `package.json` in the same directory, and it is one thing to deploy.
 * Treating each manifest as a component counted it twice and then proposed
 * infrastructure for both halves.
 */
export interface Component {
  /** Directory holding the manifests, relative to the repository root. `.` at the root. */
  path: string;
  name: string;
  kind: ComponentKind;
  ecosystems: Ecosystem[];
  manifestPaths: string[];
  /** Every declared direct dependency, recognised or not. */
  dependencyCount: number;
  /** Capabilities implied by this component's own dependencies. */
  capabilities: Capability[];
  /** The recognised subset of its dependencies. */
  dependencies: DetectedDependency[];
  /** Dockerfiles in this component's directory. */
  dockerfiles: string[];
  /** Ports this component's own Dockerfiles expose. */
  exposedPorts: number[];
  /** The compose service that builds this component, when one does. */
  composeService: string | null;
  /** Whether this is deployed, as opposed to imported by something that is. */
  deployable: boolean;
}

/**
 * A service declared in a compose file.
 *
 * Compose is the closest thing most repositories have to a statement of their
 * own topology: which processes exist, which of them are built here, which are
 * off-the-shelf infrastructure, and what talks to what.
 */
export interface ComposeService {
  name: string;
  /** The compose file this was declared in. */
  file: string;
  /** Repository-relative build context, set when the service is built here. */
  buildContext: string | null;
  /** The published image, set when the service runs one rather than building. */
  image: string | null;
  /** Managed infrastructure the image implies, e.g. `postgres` for `postgres:16`. */
  capability: Capability | null;
  /** Container ports, not host ports: the host side is a local convenience. */
  ports: number[];
  dependsOn: string[];
}

export interface Containerisation {
  dockerfiles: string[];
  composeFiles: string[];
  /**
   * Ports from `EXPOSE` directives across every Dockerfile, deduplicated.
   *
   * Retained as a repository-wide summary. Per-component ports live on the
   * component and are what synthesis reads, because the union across a monorepo
   * cannot say which port belongs to which service.
   */
  exposedPorts: number[];
}

export interface AppProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  /** The exact commit this describes. Without it the profile could be stale and unfalsifiable. */
  commitSha: string;
  ref: string;
  analysedAt: string;
  languages: LanguageBreakdown[];
  components: Component[];
  /** Repository-wide rollup, deduplicated. Kept for the summary view. */
  dependencies: DetectedDependency[];
  composeServices: ComposeService[];
  containerisation: Containerisation;
  fileCount: number;
  totalBytes: number;
  /**
   * Limits hit and ambiguities left unresolved, in plain language. Shown to the
   * user rather than kept internal, because a profile built from a truncated
   * tree should not look identical to one built from a complete read.
   */
  notes: string[];
}

/** A profile stored before the current schema, which cannot be read as one. */
export interface OutdatedProfile {
  schemaVersion: number;
}

/**
 * Whether a stored profile matches the schema this code reads.
 *
 * Stored profiles are JSON in a jsonb column, so an old one deserialises
 * happily into a shape with missing fields. Checking the version turns that
 * into a prompt to re-analyse rather than a component list where every
 * capability array is undefined.
 */
export function isCurrentProfile(profile: { schemaVersion: number }): profile is AppProfile {
  return profile.schemaVersion === PROFILE_SCHEMA_VERSION;
}

const DEPLOYABLE_KINDS = new Set<ComponentKind>([
  'api',
  'worker',
  'frontend',
  'ml-service',
  'cron',
]);

export function isDeployableKind(kind: ComponentKind): boolean {
  return DEPLOYABLE_KINDS.has(kind);
}

/** The components that get infrastructure of their own. */
export function deployables(profile: AppProfile): Component[] {
  return profile.components.filter((component) => component.deployable);
}

/** The deployable components needing a given capability, for wiring edges. */
export function componentsWith(profile: AppProfile, capability: Capability): Component[] {
  return deployables(profile).filter((component) => component.capabilities.includes(capability));
}

/** The distinct capabilities present anywhere, including in compose services. */
export function profileCapabilities(profile: AppProfile): Capability[] {
  const seen = new Set<Capability>();
  for (const dependency of profile.dependencies) {
    if (dependency.capability) seen.add(dependency.capability);
  }
  for (const service of profile.composeServices) {
    if (service.capability) seen.add(service.capability);
  }
  return [...seen];
}

export function hasCapability(profile: AppProfile, capability: Capability): boolean {
  return (
    profile.dependencies.some((dependency) => dependency.capability === capability) ||
    profile.composeServices.some((service) => service.capability === capability)
  );
}

export function isContainerised(profile: AppProfile): boolean {
  return profile.containerisation.dockerfiles.length > 0;
}

/** The dominant language by bytes, or null for an empty or unclassifiable repository. */
export function primaryLanguage(profile: AppProfile): string | null {
  return profile.languages[0]?.name ?? null;
}
