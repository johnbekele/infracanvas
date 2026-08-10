/**
 * Reading topology out of compose files.
 *
 * A compose file is the one place a repository routinely writes down its own
 * shape: which processes exist, which are built from this source tree, which are
 * off-the-shelf infrastructure, which ports they actually listen on, and what
 * depends on what. Dependency manifests can only say a Postgres driver is
 * installed somewhere; a compose file says there is one Postgres and names the
 * three services that talk to it.
 *
 * It is read as a description of intent, not of production. `postgres:16` in
 * compose means the application needs a relational database, not that anyone
 * plans to run that container in production -- which is exactly the fact needed
 * to propose a managed one.
 */
import { parse as parseYaml } from 'yaml';
import type { Capability, ComposeService } from '@infracanvas/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Managed infrastructure implied by a container image.
 *
 * Matched on the repository part of the reference, after any registry host and
 * before any tag or digest, so `public.ecr.aws/docker/library/redis:7-alpine`
 * and `redis` reach the same entry.
 */
const IMAGE_CAPABILITIES: [RegExp, Capability][] = [
  [/^(postgres|postgis|timescale|pgvector|supabase\/postgres)/, 'postgres'],
  [/^(mysql|mariadb|percona)/, 'mysql'],
  [/^(mongo|mongodb)/, 'mongodb'],
  [/^(redis|valkey|keydb|redis-stack)/, 'redis'],
  [/^(elasticsearch|opensearchproject\/opensearch|opensearch)/, 'elasticsearch'],
  [/^(qdrant|weaviate|chroma|chromadb|milvus|lancedb)/, 'vector-search'],
  [/^(neo4j|janusgraph|arangodb)/, 'graph-db'],
  [/^(cassandra|scylla)/, 'cassandra'],
  [/^clickhouse/, 'clickhouse'],
  [/^rabbitmq/, 'rabbitmq'],
  [/^(kafka|confluentinc\/|redpanda|bitnami\/kafka)/, 'kafka'],
  [/^(minio|localstack\/s3)/, 'object-storage'],
  [/^(ollama|vllm|text-generation-inference|litellm)/, 'llm-api'],
  [/^(temporal|apache\/airflow|prefecthq|dagster)/, 'workflow-orchestration'],
  [/^(prometheus|grafana|jaeger|otel\/|prom\/|open-?telemetry)/, 'observability'],
  [/^(mailhog|mailpit|maildev)/, 'email'],
  [/^(keycloak|ory\/|dexidp\/dex)/, 'identity'],
  [/^(vault|hashicorp\/vault)/, 'secrets'],
];

/**
 * Strip a registry host and a tag or digest from an image reference.
 *
 * A leading segment counts as a registry only when it looks like a host, so
 * `bitnami/kafka` keeps its organisation while `ghcr.io/acme/api` loses the host
 * but keeps `acme/api`.
 */
function imageRepository(image: string): string {
  const withoutDigest = image.split('@')[0];

  const slash = withoutDigest.indexOf('/');
  const first = slash === -1 ? '' : withoutDigest.slice(0, slash);
  const isRegistryHost = first.includes('.') || first.includes(':') || first === 'localhost';
  const withoutHost = isRegistryHost ? withoutDigest.slice(slash + 1) : withoutDigest;

  // A colon after the last slash is a tag; one before it was part of a host.
  const lastSlash = withoutHost.lastIndexOf('/');
  const colon = withoutHost.indexOf(':', lastSlash + 1);
  let repository = (colon === -1 ? withoutHost : withoutHost.slice(0, colon)).toLowerCase();

  // Mirrors of Docker Hub keep the `docker/library/` path they came from, so
  // `public.ecr.aws/docker/library/redis` has to reduce to `redis`.
  for (const prefix of ['docker.io/', 'docker/', 'library/']) {
    while (repository.startsWith(prefix)) repository = repository.slice(prefix.length);
  }

  return repository;
}

export function capabilityForImage(image: string): Capability | null {
  const repository = imageRepository(image);

  for (const [pattern, capability] of IMAGE_CAPABILITIES) {
    if (pattern.test(repository)) return capability;
  }

  return null;
}

/** Normalise `a/b/../c` and `./a` without resolving against the filesystem. */
function normalisePath(path: string): string {
  const segments: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length === 0 ? '.' : segments.join('/');
}

/** The directory holding a file, using `.` for the repository root. */
function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
}

/**
 * A build context resolved to a repository path.
 *
 * Compose resolves relative to the compose file, so a nested compose file
 * pointing at `../api` names a directory the analyser knows by a different
 * string until it is normalised.
 */
function resolveBuildContext(composeFile: string, raw: unknown): string | null {
  const context = isRecord(raw)
    ? typeof raw.context === 'string'
      ? raw.context
      : null
    : typeof raw === 'string'
      ? raw
      : null;

  if (context === null) return null;

  const base = directoryOf(composeFile);
  return normalisePath(base === '.' ? context : `${base}/${context}`);
}

/**
 * Container ports for a service.
 *
 * A compose port mapping is written host-first, and the host side says nothing
 * about the application: it is picked to avoid collisions on a laptop. The
 * container side is the port the process listens on, so it is the one taken.
 */
function parsePorts(raw: unknown): number[] {
  const ports: number[] = [];

  const add = (value: string) => {
    // Trailing `/tcp`, and a possible `8000-8010` range where the low end is
    // representative enough for the purpose.
    const port = Number.parseInt(value.split('/')[0].split('-')[0], 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
  };

  if (!Array.isArray(raw)) return ports;

  for (const entry of raw) {
    if (typeof entry === 'number') {
      add(String(entry));
      continue;
    }

    if (typeof entry === 'string') {
      // `8080`, `8080:80`, `127.0.0.1:8080:80`. The container port is last.
      const parts = entry.split(':');
      add(parts[parts.length - 1]);
      continue;
    }

    // The long form: `{ target: 80, published: 8080 }`.
    if (isRecord(entry) && (typeof entry.target === 'number' || typeof entry.target === 'string')) {
      add(String(entry.target));
    }
  }

  return [...new Set(ports)].sort((a, b) => a - b);
}

/** `depends_on` is either a list of names or a map keyed by them. */
function parseDependsOn(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((name): name is string => typeof name === 'string');
  if (isRecord(raw)) return Object.keys(raw);
  return [];
}

/**
 * Parse one compose file into its services.
 *
 * A file that is not valid YAML, or that is some other YAML file matching the
 * compose naming convention, yields no services rather than failing. Compose is
 * supporting evidence: losing it costs precision, and failing the analysis over
 * it costs the user everything else the repository had to say.
 */
export function parseCompose(file: string, source: string): ComposeService[] {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch {
    return [];
  }

  if (!isRecord(document) || !isRecord(document.services)) return [];

  const services: ComposeService[] = [];

  for (const [name, raw] of Object.entries(document.services)) {
    if (!isRecord(raw)) continue;

    const image = typeof raw.image === 'string' ? raw.image : null;
    const buildContext = resolveBuildContext(file, raw.build);

    services.push({
      name,
      file,
      buildContext,
      image,
      // A service that builds from this repository is application code, whatever
      // its image happens to be named. Only images it does not build imply
      // infrastructure to provision.
      capability: buildContext === null && image !== null ? capabilityForImage(image) : null,
      ports: [...parsePorts(raw.ports), ...parsePorts(raw.expose)].sort((a, b) => a - b),
      dependsOn: parseDependsOn(raw.depends_on),
    });
  }

  return services;
}

/**
 * Merge services declared across several compose files.
 *
 * Repositories routinely ship a base file plus overrides for development or
 * HTTPS, and the same service appears in each. The base file is read first, so
 * the first definition of a name wins and an override contributes only ports and
 * dependencies the base did not state.
 */
export function mergeComposeServices(all: ComposeService[]): ComposeService[] {
  const byName = new Map<string, ComposeService>();

  for (const service of all) {
    const existing = byName.get(service.name);

    if (!existing) {
      byName.set(service.name, { ...service });
      continue;
    }

    existing.buildContext ??= service.buildContext;
    existing.image ??= service.image;
    existing.capability ??= service.capability;
    existing.ports = [...new Set([...existing.ports, ...service.ports])].sort((a, b) => a - b);
    existing.dependsOn = [...new Set([...existing.dependsOn, ...service.dependsOn])];
  }

  return [...byName.values()];
}
