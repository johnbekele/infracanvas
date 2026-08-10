/**
 * Building an application profile from a repository.
 *
 * The whole analysis is deterministic: the same commit produces the same
 * profile, and every finding names the file it came from. That is a deliberate
 * choice rather than a limitation. The profile decides which infrastructure
 * gets provisioned, so it needs to be something a user can disagree with and
 * check, not something they have to trust.
 *
 * Findings are attributed to the directory that declared them. A repository-wide
 * list can say only that something here uses Postgres, which supports drawing
 * one database and nothing more; knowing which three of seven services use it is
 * what lets an architecture be proposed rather than a template filled in.
 */
import {
  PROFILE_SCHEMA_VERSION,
  type AppProfile,
  type Capability,
  type Component,
  type ComposeService,
  type DetectedDependency,
  type Ecosystem,
  type LanguageBreakdown,
} from '@infracanvas/core';
import {
  LIMITS,
  fetchBlobText,
  fetchLanguages,
  fetchTree,
  resolveCommit,
  type TreeEntry,
} from './github-source.js';
import { MANIFEST_FILENAMES, parseDockerfilePorts, parseManifest } from './manifests.js';
import { lookupSignature } from './signatures.js';
import { mergeComposeServices, parseCompose } from './compose.js';
import { classifyComponent, isDeployable } from './classify.js';

export interface AnalyzeInput {
  token: string;
  owner: string;
  repo: string;
  ref: string;
}

/**
 * Directories holding code the repository did not write.
 *
 * A checked-in `node_modules` would otherwise contribute thousands of manifests
 * and make the application look like it depends on everything on the registry.
 */
const VENDORED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'bower_components',
  '.venv',
  'venv',
  'site-packages',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.git',
  'third_party',
]);

function isVendored(path: string): boolean {
  return path.split('/').some((segment) => VENDORED_DIRECTORIES.has(segment));
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The directory holding a file, using `.` for the repository root. */
function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
}

function isDockerfile(name: string): boolean {
  return name === 'Dockerfile' || name.startsWith('Dockerfile.');
}

function isComposeFile(name: string): boolean {
  return /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(name);
}

/**
 * Run tasks with a bounded number in flight.
 *
 * Manifests are fetched one blob per request, and a large monorepo has dozens.
 * Issuing them all at once is the fastest way to be rate-limited by GitHub and
 * to hold every response in memory simultaneously; a small pool keeps both
 * bounded while still overlapping the latency.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

const FETCH_CONCURRENCY = 8;

function toLanguageBreakdown(languages: Record<string, number>): LanguageBreakdown[] {
  const total = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
  if (total === 0) return [];

  return Object.entries(languages)
    .map(([name, bytes]) => ({ name, bytes, share: bytes / total }))
    .sort((a, b) => b.bytes - a.bytes);
}

interface CandidateFile {
  entry: TreeEntry;
  name: string;
}

function selectCandidates(entries: TreeEntry[]): {
  manifests: CandidateFile[];
  dockerfiles: CandidateFile[];
  composeFiles: CandidateFile[];
  notes: string[];
} {
  const manifests: CandidateFile[] = [];
  const dockerfiles: CandidateFile[] = [];
  const composeFiles: CandidateFile[] = [];
  const notes: string[] = [];

  let oversizeManifests = 0;

  for (const entry of entries) {
    if (entry.type !== 'blob' || isVendored(entry.path)) continue;

    const name = fileName(entry.path);

    if (name in MANIFEST_FILENAMES) {
      if ((entry.size ?? 0) > LIMITS.maxManifestBytes) {
        oversizeManifests += 1;
        continue;
      }
      manifests.push({ entry, name });
    } else if (isDockerfile(name)) {
      dockerfiles.push({ entry, name });
    } else if (isComposeFile(name)) {
      composeFiles.push({ entry, name });
    }
  }

  if (oversizeManifests > 0) {
    notes.push(
      `Skipped ${oversizeManifests} manifest file(s) larger than ${LIMITS.maxManifestBytes / 1024} KB.`
    );
  }

  // Shallower paths first, so that when the cap bites it keeps the top-level
  // components -- the ones that are actually deployed -- over nested fixtures.
  const byDepth = (a: CandidateFile, b: CandidateFile) =>
    a.entry.path.split('/').length - b.entry.path.split('/').length;

  manifests.sort(byDepth);
  dockerfiles.sort(byDepth);
  composeFiles.sort(byDepth);

  if (manifests.length > LIMITS.maxManifests) {
    notes.push(
      `Repository has ${manifests.length} dependency manifests; analysed the ${LIMITS.maxManifests} closest to the root.`
    );
  }

  return {
    manifests: manifests.slice(0, LIMITS.maxManifests),
    dockerfiles: dockerfiles.slice(0, LIMITS.maxDockerfiles),
    composeFiles: composeFiles.slice(0, LIMITS.maxComposeFiles),
    notes,
  };
}

/** Everything one directory's manifests declared, before it becomes a component. */
interface Draft {
  path: string;
  names: string[];
  ecosystems: Set<Ecosystem>;
  manifestPaths: string[];
  dependencyCount: number;
  dependencies: DetectedDependency[];
  libraryHint: boolean;
  dockerfiles: string[];
  exposedPorts: Set<number>;
}

function draftFor(drafts: Map<string, Draft>, path: string): Draft {
  const existing = drafts.get(path);
  if (existing) return existing;

  const created: Draft = {
    path,
    names: [],
    ecosystems: new Set(),
    manifestPaths: [],
    dependencyCount: 0,
    dependencies: [],
    libraryHint: true,
    dockerfiles: [],
    exposedPorts: new Set(),
  };
  drafts.set(path, created);
  return created;
}

/**
 * The component a file belongs to: the nearest one at or above its directory.
 *
 * A Dockerfile under `apps/api/docker/` builds part of `apps/api`, and a
 * Dockerfile at the repository root with components beneath it belongs to the
 * root. Walking upward attributes both without needing a rule per layout.
 */
function nearestComponentPath(path: string, componentPaths: Set<string>): string | null {
  let directory = directoryOf(path);

  for (;;) {
    if (componentPaths.has(directory)) return directory;
    if (directory === '.') return null;
    directory = directoryOf(directory);
  }
}

/** The name that best identifies a directory holding several manifests. */
function pickName(names: string[], path: string, repo: string): string {
  // A scoped or namespaced package name is more specific than a bare one, and a
  // directory name beats both when the manifests only echo it back.
  const specific = names.find((name) => name.includes('/'));
  if (specific) return specific;
  return names[0] ?? (path === '.' ? repo : fileName(path));
}

export async function analyzeRepository(input: AnalyzeInput): Promise<AppProfile> {
  const { token, owner, repo, ref } = input;

  const commitSha = await resolveCommit({ token, owner, repo, ref });

  const [tree, languages] = await Promise.all([
    fetchTree({ token, owner, repo, commitSha }),
    fetchLanguages({ token, owner, repo }),
  ]);

  const { manifests, dockerfiles, composeFiles, notes } = selectCandidates(tree.entries);

  if (tree.truncated) {
    notes.push(
      'GitHub truncated the file listing for this repository, so some components may be missing.'
    );
  }

  const fetchText = (candidate: CandidateFile) =>
    fetchBlobText({ token, owner, repo, sha: candidate.entry.sha });

  const [manifestTexts, dockerfileTexts, composeTexts] = await Promise.all([
    mapWithConcurrency(manifests, FETCH_CONCURRENCY, fetchText),
    mapWithConcurrency(dockerfiles, FETCH_CONCURRENCY, fetchText),
    mapWithConcurrency(composeFiles, FETCH_CONCURRENCY, fetchText),
  ]);

  // One draft per directory. Two manifests side by side -- a `pyproject.toml`
  // for the service and a `package.json` for the assets it serves -- describe
  // one thing to deploy, and counting them separately proposed two.
  const drafts = new Map<string, Draft>();
  let unparseable = 0;

  manifests.forEach((candidate, index) => {
    const directory = directoryOf(candidate.entry.path);
    const fallbackName = directory === '.' ? repo : fileName(directory);
    const parsed = parseManifest(candidate.name, manifestTexts[index], fallbackName);

    if (!parsed) {
      unparseable += 1;
      return;
    }

    const draft = draftFor(drafts, directory);
    draft.names.push(parsed.name);
    draft.ecosystems.add(parsed.ecosystem);
    draft.manifestPaths.push(candidate.entry.path);
    draft.dependencyCount += parsed.dependencies.length;
    // One manifest declaring itself deployable is enough for the directory.
    draft.libraryHint &&= parsed.libraryHint;

    const seenInDraft = new Set(
      draft.dependencies.map((dependency) => `${dependency.ecosystem}:${dependency.name}`)
    );

    for (const dependencyName of parsed.dependencies) {
      const signature = lookupSignature(parsed.ecosystem, dependencyName);
      if (!signature) continue;

      const key = `${parsed.ecosystem}:${dependencyName.toLowerCase()}`;
      if (seenInDraft.has(key)) continue;
      seenInDraft.add(key);

      draft.dependencies.push({
        name: dependencyName,
        ecosystem: parsed.ecosystem,
        category: signature.category,
        capability: signature.capability,
        sourcePath: candidate.entry.path,
      });
    }
  });

  if (unparseable > 0) {
    notes.push(`${unparseable} manifest file(s) could not be parsed and were skipped.`);
  }

  const componentPaths = new Set(drafts.keys());

  dockerfiles.forEach((candidate, index) => {
    const ports = parseDockerfilePorts(dockerfileTexts[index]);
    const owningPath = nearestComponentPath(candidate.entry.path, componentPaths);
    if (owningPath === null) return;

    const draft = drafts.get(owningPath);
    if (!draft) return;

    draft.dockerfiles.push(candidate.entry.path);
    for (const port of ports) draft.exposedPorts.add(port);
  });

  const composeServices = mergeComposeServices(
    composeFiles.flatMap((candidate, index) =>
      parseCompose(candidate.entry.path, composeTexts[index])
    )
  );

  const buildContexts = new Map<string, string>();
  for (const service of composeServices) {
    if (service.buildContext && !buildContexts.has(service.buildContext)) {
      buildContexts.set(service.buildContext, service.name);
    }
  }

  const components: Component[] = [...drafts.values()]
    .map((draft) => {
      const capabilities = [
        ...new Set(
          draft.dependencies
            .map((dependency) => dependency.capability)
            .filter((capability): capability is Capability => capability !== null)
        ),
      ];

      const composeService = buildContexts.get(draft.path) ?? null;
      const hasNestedComponents = [...componentPaths].some(
        (other) =>
          other !== draft.path && (draft.path === '.' || other.startsWith(`${draft.path}/`))
      );

      const kind = classifyComponent({
        path: draft.path,
        capabilities,
        dockerfiles: draft.dockerfiles,
        hasComposeService: composeService !== null,
        libraryHint: draft.libraryHint,
        hasNestedComponents,
      });

      const packaged = draft.dockerfiles.length > 0 || composeService !== null;

      return {
        path: draft.path,
        name: pickName(draft.names, draft.path, repo),
        kind,
        ecosystems: [...draft.ecosystems],
        manifestPaths: draft.manifestPaths,
        dependencyCount: draft.dependencyCount,
        capabilities,
        dependencies: draft.dependencies,
        dockerfiles: draft.dockerfiles,
        exposedPorts: [...draft.exposedPorts].sort((a, b) => a - b),
        composeService,
        deployable: isDeployable(kind, packaged),
      } satisfies Component;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  // The repository-wide rollup, deduplicated. It answers "does anything here use
  // Redis", which the summary view asks and synthesis no longer has to.
  const dependencies: DetectedDependency[] = [];
  const seen = new Set<string>();
  for (const component of components) {
    for (const dependency of component.dependencies) {
      const key = `${dependency.ecosystem}:${dependency.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push(dependency);
    }
  }

  if (dependencies.some((dependency) => dependency.category === 'orm')) {
    notes.push(
      'An ORM was found but the database engine it targets is set in configuration, not in the manifest, so it was not inferred.'
    );
  }

  const unmatchedBuilds = composeServices.filter(
    (service) => service.buildContext !== null && !componentPaths.has(service.buildContext)
  );
  if (unmatchedBuilds.length > 0) {
    notes.push(
      `${unmatchedBuilds.length} compose service(s) build from a directory with no dependency manifest, so their dependencies are unknown: ${unmatchedBuilds.map((service) => service.name).join(', ')}.`
    );
  }

  const blobs = tree.entries.filter((entry) => entry.type === 'blob');

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    commitSha,
    ref,
    analysedAt: new Date().toISOString(),
    languages: toLanguageBreakdown(languages),
    components,
    dependencies,
    composeServices: composeServices satisfies ComposeService[],
    containerisation: {
      dockerfiles: dockerfiles.map((candidate) => candidate.entry.path),
      composeFiles: composeFiles.map((candidate) => candidate.entry.path),
      exposedPorts: [...new Set(dockerfileTexts.flatMap(parseDockerfilePorts))].sort(
        (a, b) => a - b
      ),
    },
    fileCount: blobs.length,
    totalBytes: blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    notes,
  };
}
