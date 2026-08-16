#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function stripCodeFences(markdown) {
  return markdown.replace(/^```[\s\S]*?^```/gm, (block) =>
    block
      .split('\n')
      .map(() => '')
      .join('\n')
  );
}

function normaliseTarget(rawTarget) {
  const withoutTitle = rawTarget.trim().split(/\s+(?=(?:"[^"]*"|'[^']*'|\([^)]*\))$)/)[0] ?? '';
  const decoded = withoutTitle.replace(/^<|>$/g, '');
  const [withoutAnchor] = decoded.split('#');
  const [withoutQuery] = withoutAnchor.split('?');
  return withoutQuery.trim();
}

function isExternalTarget(target) {
  return (
    target === '' ||
    target.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith('//')
  );
}

export function findRelativeMarkdownLinks(filePath, repoRoot = REPO_ROOT) {
  const absoluteFile = path.resolve(repoRoot, filePath);
  const markdown = stripCodeFences(readFileSync(absoluteFile, 'utf8'));
  const links = [];
  const pattern = /!?\[[^\]\n]*]\(([^)\n]+)\)/g;

  for (const match of markdown.matchAll(pattern)) {
    const rawTarget = match[1];
    const target = normaliseTarget(rawTarget);
    if (isExternalTarget(target)) continue;

    const line = markdown.slice(0, match.index).split('\n').length;
    links.push({
      filePath,
      line,
      target,
      resolvedPath: path.resolve(repoRoot, target),
    });
  }

  return links;
}

export function checkDocLinks(files, repoRoot = REPO_ROOT) {
  const missing = [];

  for (const file of files) {
    for (const link of findRelativeMarkdownLinks(file, repoRoot)) {
      if (!existsSync(link.resolvedPath)) {
        missing.push(link);
        continue;
      }

      const targetStats = statSync(link.resolvedPath);
      if (!targetStats.isFile() && !targetStats.isDirectory()) {
        missing.push(link);
      }
    }
  }

  return missing;
}

function main(argv) {
  if (argv.length === 0) {
    console.error('Usage: node scripts/ci/check-doc-links.mjs <file>...');
    return 1;
  }

  const missing = checkDocLinks(argv);
  for (const link of missing) {
    console.error(
      `${link.filePath}:${link.line}: relative link target does not exist: ${link.target}`
    );
  }

  return missing.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
