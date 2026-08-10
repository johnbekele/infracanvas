/**
 * Reading dependency manifests.
 *
 * Each parser extracts only what the profile needs -- the component's name and
 * the names of its direct dependencies -- and ignores versions entirely. A
 * version constrains which release is installed; it does not change whether the
 * application needs a database.
 *
 * Transitive dependencies are deliberately not followed. A library that happens
 * to pull in a Redis client several levels down does not mean the application
 * needs Redis, and treating it as though it did would provision infrastructure
 * nobody asked for.
 */
import { parse as parseToml } from 'smol-toml';
import type { Ecosystem } from '@infracanvas/core';

export interface ParsedManifest {
  ecosystem: Ecosystem;
  /** Falls back to the containing directory when the manifest declares no name. */
  name: string;
  /**
   * The manifest describes something importable rather than something run: a
   * published package, or a workspace root that only lists members. Only a hint,
   * because the deciding evidence -- a Dockerfile, a compose service -- lives
   * outside the manifest.
   */
  libraryHint: boolean;
  dependencies: string[];
}

/** Manifest filenames recognised, mapped to the ecosystem they belong to. */
export const MANIFEST_FILENAMES: Record<string, Ecosystem> = {
  'package.json': 'npm',
  'requirements.txt': 'pypi',
  'pyproject.toml': 'pypi',
  'go.mod': 'go',
  'Cargo.toml': 'cargo',
  'pom.xml': 'maven',
  'build.gradle': 'maven',
  'build.gradle.kts': 'maven',
  Gemfile: 'rubygems',
  'composer.json': 'composer',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

/**
 * A leading name from a requirement string such as `fastapi>=0.100,<1` or
 * `torch==2.1.0+cu118`. Extras (`uvicorn[standard]`) are dropped because the
 * package is the same either way.
 */
function requirementName(line: string): string | null {
  const withoutComment = line.split('#')[0].trim();
  if (!withoutComment) return null;
  // Options (`-r other.txt`, `--index-url ...`) and direct URLs are not packages.
  if (withoutComment.startsWith('-') || withoutComment.includes('://')) return null;

  const match = /^([A-Za-z0-9._-]+)/.exec(withoutComment);
  return match ? match[1] : null;
}

function parsePackageJson(content: string, fallbackName: string): ParsedManifest {
  const parsed: unknown = JSON.parse(content);
  const manifest = isRecord(parsed) ? parsed : {};

  const dependencies = [
    ...keysOf(manifest.dependencies),
    // Dev dependencies are included because a frontend build tool appears only
    // there, and whether a repository builds a static bundle is exactly the
    // kind of thing that changes the architecture.
    ...keysOf(manifest.devDependencies),
  ];

  // A manifest listing workspaces is the root of one, whatever else it declares.
  const isWorkspaceRoot = manifest.workspaces !== undefined;
  const runsSomething = manifest.private === true || isRecord(manifest.scripts);

  return {
    ecosystem: 'npm',
    name: typeof manifest.name === 'string' ? manifest.name : fallbackName,
    libraryHint: isWorkspaceRoot || !runsSomething,
    dependencies,
  };
}

function parseRequirementsTxt(content: string, fallbackName: string): ParsedManifest {
  const dependencies = content
    .split('\n')
    .map(requirementName)
    .filter((name): name is string => name !== null);

  return { ecosystem: 'pypi', name: fallbackName, libraryHint: false, dependencies };
}

function parsePyprojectToml(content: string, fallbackName: string): ParsedManifest {
  const parsed = parseToml(content) as Record<string, unknown>;
  const project = isRecord(parsed.project) ? parsed.project : {};

  const dependencies: string[] = [];

  // PEP 621: an array of requirement strings.
  if (Array.isArray(project.dependencies)) {
    for (const entry of project.dependencies) {
      if (typeof entry !== 'string') continue;
      const name = requirementName(entry);
      if (name) dependencies.push(name);
    }
  }

  // Poetry predates PEP 621 and uses a table keyed by package name instead.
  const tool = isRecord(parsed.tool) ? parsed.tool : {};
  const poetry = isRecord(tool.poetry) ? tool.poetry : {};
  for (const name of keysOf(poetry.dependencies)) {
    if (name !== 'python') dependencies.push(name);
  }

  const name =
    typeof project.name === 'string'
      ? project.name
      : typeof poetry.name === 'string'
        ? poetry.name
        : fallbackName;

  return { ecosystem: 'pypi', name, libraryHint: false, dependencies };
}

/**
 * `go.mod` is a line-oriented format, so it is read directly rather than with a
 * parser. Only the `require` directives are of interest, in both their single
 * and parenthesised block forms.
 */
function parseGoMod(content: string, fallbackName: string): ParsedManifest {
  const dependencies: string[] = [];
  let moduleName = fallbackName;
  let insideRequireBlock = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('//')[0].trim();
    if (!line) continue;

    if (line.startsWith('module ')) {
      moduleName = line.slice('module '.length).trim();
      continue;
    }

    if (insideRequireBlock) {
      if (line === ')') {
        insideRequireBlock = false;
        continue;
      }
      const [path] = line.split(/\s+/);
      if (path) dependencies.push(path);
      continue;
    }

    if (line === 'require (') {
      insideRequireBlock = true;
      continue;
    }

    if (line.startsWith('require ')) {
      const [path] = line.slice('require '.length).trim().split(/\s+/);
      if (path) dependencies.push(path);
    }
  }

  return { ecosystem: 'go', name: moduleName, libraryHint: false, dependencies };
}

function parseCargoToml(content: string, fallbackName: string): ParsedManifest {
  const parsed = parseToml(content) as Record<string, unknown>;
  const pkg = isRecord(parsed.package) ? parsed.package : {};

  const dependencies = [...keysOf(parsed.dependencies), ...keysOf(parsed['dev-dependencies'])];

  // A virtual workspace manifest declares members but no package of its own.
  const isWorkspaceRoot = !isRecord(parsed.package) && isRecord(parsed.workspace);

  return {
    ecosystem: 'cargo',
    name: typeof pkg.name === 'string' ? pkg.name : fallbackName,
    libraryHint: isWorkspaceRoot,
    dependencies,
  };
}

/**
 * Maven and Gradle are matched by pattern rather than parsed.
 *
 * Extracting artifact ids from XML with a regex is imprecise, and a Gradle
 * build file is a program rather than data, so neither can be read exactly
 * without a build-tool-sized dependency. The names are only used to look up
 * signatures, where a missed entry costs a suggestion rather than correctness.
 */
function parseMavenLike(content: string, fallbackName: string): ParsedManifest {
  const dependencies = new Set<string>();

  for (const match of content.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g)) {
    dependencies.add(match[1]);
  }

  // Gradle: `implementation "org.group:artifact:version"` and its variants.
  for (const match of content.matchAll(/['"][\w.-]+:([\w.-]+)(?::[^'"]*)?['"]/g)) {
    dependencies.add(match[1]);
  }

  return {
    ecosystem: 'maven',
    name: fallbackName,
    libraryHint: false,
    dependencies: [...dependencies],
  };
}

/** A Gemfile is Ruby, so only the `gem "name"` declarations are matched. */
function parseGemfile(content: string, fallbackName: string): ParsedManifest {
  const dependencies: string[] = [];

  for (const match of content.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) {
    dependencies.push(match[1]);
  }

  return { ecosystem: 'rubygems', name: fallbackName, libraryHint: false, dependencies };
}

function parseComposerJson(content: string, fallbackName: string): ParsedManifest {
  const parsed: unknown = JSON.parse(content);
  const manifest = isRecord(parsed) ? parsed : {};

  const dependencies = [...keysOf(manifest.require), ...keysOf(manifest['require-dev'])].filter(
    // Platform requirements, not packages.
    (name) => name !== 'php' && !name.startsWith('ext-')
  );

  return {
    ecosystem: 'composer',
    name: typeof manifest.name === 'string' ? manifest.name : fallbackName,
    libraryHint: false,
    dependencies,
  };
}

/**
 * Parse a manifest by filename.
 *
 * Returns null when the file is not a recognised manifest or cannot be read.
 * A malformed manifest is a normal thing to encounter in a real repository --
 * a template with placeholders, a file mid-edit -- and it should cost that one
 * component rather than the whole analysis.
 */
export function parseManifest(
  filename: string,
  content: string,
  fallbackName: string
): ParsedManifest | null {
  try {
    switch (filename) {
      case 'package.json':
        return parsePackageJson(content, fallbackName);
      case 'requirements.txt':
        return parseRequirementsTxt(content, fallbackName);
      case 'pyproject.toml':
        return parsePyprojectToml(content, fallbackName);
      case 'go.mod':
        return parseGoMod(content, fallbackName);
      case 'Cargo.toml':
        return parseCargoToml(content, fallbackName);
      case 'pom.xml':
      case 'build.gradle':
      case 'build.gradle.kts':
        return parseMavenLike(content, fallbackName);
      case 'Gemfile':
        return parseGemfile(content, fallbackName);
      case 'composer.json':
        return parseComposerJson(content, fallbackName);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Ports from `EXPOSE` directives, which say how a container is reached. */
export function parseDockerfilePorts(content: string): number[] {
  const ports: number[] = [];

  for (const match of content.matchAll(/^\s*EXPOSE\s+(.+)$/gim)) {
    for (const token of match[1].split(/\s+/)) {
      // `EXPOSE 8080/tcp` carries a protocol suffix.
      const port = Number.parseInt(token.split('/')[0], 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
    }
  }

  return ports;
}
