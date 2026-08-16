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
  /**
   * Called as the analysis advances, with a fraction from 0 to 1.
   *
   * Reported rather than inferred from elapsed time: the fetch phase dominates
   * and its length depends on how many manifests the repository has, so a clock
   * would be guessing at exactly the point a user most wants to know whether
   * anything is happening.
   */
  onProgress?: (fraction: number, message: string) => void | Promise<void>;
  /** Abort a run whose result nobody is waiting for any more. */
  signal?: AbortSignal;
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
  task: (item: T) => Promise<R>,
  onSettled?: () => void
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
      onSettled?.();
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

/**
 * How far through the run each phase is considered to be.
 *
 * Fetching file contents is the only phase whose length varies with the
 * repository, so it gets the widest band and reports inside itself. The rest are
 * fixed points, which is honest: they either happened or they did not.
 */
const PHASE = {
  resolved: 0.05,
  listed: 0.1,
  fetchStart: 0.15,
  fetchEnd: 0.85,
  built: 0.95,
} as const;

export async function analyzeRepository(input: AnalyzeInput): Promise<AppProfile> {
  const { token, owner, repo, ref, signal } = input;

  // Reporting must never be the reason an analysis fails, and a caller that is
  // not watching should not pay for a progress channel it never reads.
  const report = async (fraction: number, message: string) => {
    if (!input.onProgress) return;
    await input.onProgress(fraction, message);
  };

  const stopIfAbandoned = () => {
    if (signal?.aborted) throw new Error('Analysis was cancelled.');
  };

  const commitSha = await resolveCommit({ token, owner, repo, ref, signal });
  await report(PHASE.resolved, `Resolved ${ref} to ${commitSha.slice(0, 7)}.`);
  stopIfAbandoned();

  const [tree, languages] = await Promise.all([
    fetchTree({ token, owner, repo, commitSha, signal }),
    fetchLanguages({ token, owner, repo, signal }),
  ]);

  const { manifests, dockerfiles, composeFiles, notes } = selectCandidates(tree.entries);

  const fileCount = manifests.length + dockerfiles.length + composeFiles.length;
  await report(
    PHASE.listed,
    `Listed ${tree.entries.length} files; ${fileCount} describe how this repository is built.`
  );
  stopIfAbandoned();

  if (tree.truncated) {
    notes.push(
      'GitHub truncated the file listing for this repository, so some components may be missing.'
    );
  }

  const fetchText = (candidate: CandidateFile) => {
    stopIfAbandoned();
    return fetchBlobText({ token, owner, repo, sha: candidate.entry.sha, signal });
  };

  // Reported from a shared counter rather than per phase, because the three
  // phases run concurrently and a user watching wants one number, not three that
  // each restart at zero.
  let fetched = 0;
  const span = PHASE.fetchEnd - PHASE.fetchStart;
  const countFetch = () => {
    fetched += 1;
    // One line per file would write 170 rows for a large monorepo to say the same
    // thing 170 times. A tenth of the way through is the granularity a progress
    // bar can actually show.
    const step = Math.max(1, Math.ceil(fileCount / 10));
    if (fetched % step !== 0 && fetched !== fileCount) return;

    // Awaiting a database write here would serialise the fetches it is measuring.
    void report(
      PHASE.fetchStart + (fileCount === 0 ? span : (fetched / fileCount) * span),
      `Read ${fetched} of ${fileCount} files.`
    );
  };

  const [manifestTexts, dockerfileTexts, composeTexts] = await Promise.all([
    mapWithConcurrency(manifests, FETCH_CONCURRENCY, fetchText, countFetch),
    mapWithConcurrency(dockerfiles, FETCH_CONCURRENCY, fetchText, countFetch),
    mapWithConcurrency(composeFiles, FETCH_CONCURRENCY, fetchText, countFetch),
  ]);

  stopIfAbandoned();

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

  await report(
    PHASE.built,
    `Found ${components.length} component(s) and ${dependencies.length} notable dependency(s).`
  );

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
