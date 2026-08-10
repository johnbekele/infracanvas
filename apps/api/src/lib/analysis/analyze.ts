/**
 * Building an application profile from a repository.
 *
 * The whole analysis is deterministic: the same commit produces the same
 * profile, and every finding names the file it came from. That is a deliberate
 * choice rather than a limitation. The profile decides which infrastructure
 * gets provisioned, so it needs to be something a user can disagree with and
 * check, not something they have to trust.
 */
import {
  PROFILE_SCHEMA_VERSION,
  type AppProfile,
  type Component,
  type DetectedDependency,
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

  if (manifests.length > LIMITS.maxManifests) {
    notes.push(
      `Repository has ${manifests.length} dependency manifests; analysed the ${LIMITS.maxManifests} closest to the root.`
    );
  }

  return {
    manifests: manifests.slice(0, LIMITS.maxManifests),
    dockerfiles: dockerfiles.slice(0, LIMITS.maxDockerfiles),
    composeFiles: composeFiles.slice(0, LIMITS.maxDockerfiles),
    notes,
  };
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

  const [manifestTexts, dockerfileTexts] = await Promise.all([
    mapWithConcurrency(manifests, FETCH_CONCURRENCY, fetchText),
    mapWithConcurrency(dockerfiles, FETCH_CONCURRENCY, fetchText),
  ]);

  const components: Component[] = [];
  const dependencies: DetectedDependency[] = [];
  // Deduplicates by ecosystem and name, so a dependency shared by five
  // components is one finding rather than five identical ones.
  const seenDependencies = new Set<string>();
  let unparseable = 0;

  manifests.forEach((candidate, index) => {
    const directory = directoryOf(candidate.entry.path);
    const fallbackName = directory === '.' ? repo : fileName(directory);
    const parsed = parseManifest(candidate.name, manifestTexts[index], fallbackName);

    if (!parsed) {
      unparseable += 1;
      return;
    }

    components.push({
      path: directory,
      name: parsed.name,
      ecosystem: parsed.ecosystem,
      kind: parsed.kind,
      manifestPath: candidate.entry.path,
      dependencyCount: parsed.dependencies.length,
    });

    for (const dependencyName of parsed.dependencies) {
      const signature = lookupSignature(parsed.ecosystem, dependencyName);
      if (!signature) continue;

      const key = `${parsed.ecosystem}:${dependencyName.toLowerCase()}`;
      if (seenDependencies.has(key)) continue;
      seenDependencies.add(key);

      dependencies.push({
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

  if (dependencies.some((dependency) => dependency.category === 'orm')) {
    notes.push(
      'An ORM was found but the database engine it targets is set in configuration, not in the manifest, so it was not inferred.'
    );
  }

  const exposedPorts = [...new Set(dockerfileTexts.flatMap(parseDockerfilePorts))].sort(
    (a, b) => a - b
  );

  const blobs = tree.entries.filter((entry) => entry.type === 'blob');

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    commitSha,
    ref,
    analysedAt: new Date().toISOString(),
    languages: toLanguageBreakdown(languages),
    components,
    dependencies,
    containerisation: {
      dockerfiles: dockerfiles.map((candidate) => candidate.entry.path),
      composeFiles: composeFiles.map((candidate) => candidate.entry.path),
      exposedPorts,
    },
    fileCount: blobs.length,
    totalBytes: blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    notes,
  };
}
