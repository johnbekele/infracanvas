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
 */

export const PROFILE_SCHEMA_VERSION = 1;

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
  | 'http-server'
  | 'graphql'
  | 'grpc'
  | 'websocket'
  | 'frontend'
  | 'postgres'
  | 'mysql'
  | 'mongodb'
  | 'redis'
  | 'elasticsearch'
  | 'kafka'
  | 'rabbitmq'
  | 'background-jobs'
  | 'object-storage'
  | 'ml-inference'
  | 'email';

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
  | 'orm'
  | 'cloud-sdk'
  | 'ml'
  | 'other';

export type ComponentKind = 'service' | 'frontend' | 'library' | 'worker' | 'unknown';

export interface LanguageBreakdown {
  name: string;
  bytes: number;
  /** Fraction of all classified bytes, 0 to 1. */
  share: number;
}

/** A deployable or publishable unit, one per dependency manifest found. */
export interface Component {
  /** Directory holding the manifest, relative to the repository root. `.` at the root. */
  path: string;
  name: string;
  ecosystem: Ecosystem;
  kind: ComponentKind;
  manifestPath: string;
  dependencyCount: number;
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

export interface Containerisation {
  dockerfiles: string[];
  composeFiles: string[];
  /**
   * Ports from `EXPOSE` directives, deduplicated.
   *
   * Only from Dockerfiles. A compose file publishes ports for the databases and
   * queues it runs alongside the application too, so mixing the two produces a
   * list in which the application's own port is indistinguishable from
   * Postgres's.
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
  dependencies: DetectedDependency[];
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

/** The distinct capabilities present, which is what architecture selection keys off. */
export function profileCapabilities(profile: AppProfile): Capability[] {
  const seen = new Set<Capability>();
  for (const dependency of profile.dependencies) {
    if (dependency.capability) seen.add(dependency.capability);
  }
  return [...seen];
}

export function hasCapability(profile: AppProfile, capability: Capability): boolean {
  return profile.dependencies.some((dependency) => dependency.capability === capability);
}

export function isContainerised(profile: AppProfile): boolean {
  return profile.containerisation.dockerfiles.length > 0;
}

/** The dominant language by bytes, or null for an empty or unclassifiable repository. */
export function primaryLanguage(profile: AppProfile): string | null {
  return profile.languages[0]?.name ?? null;
}
