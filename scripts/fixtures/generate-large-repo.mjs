#!/usr/bin/env node
/**
 * Deterministic large-repo fixture for Gate 6 ingest performance.
 *
 * Usage:
 *   node scripts/fixtures/generate-large-repo.mjs --files 100000 --out tests/fixtures/repos/large
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function parseArgs(argv) {
  let files = 100_000;
  let out = 'tests/fixtures/repos/large';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--files') {
      files = Number(argv[++i]);
    } else if (arg === '--out') {
      out = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/fixtures/generate-large-repo.mjs [--files N] [--out DIR]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(files) || files < 1) {
    console.error('--files must be a positive number');
    process.exit(2);
  }
  return { files, out };
}

function contentFor(index) {
  // Stable, compressible source that still exercises the TypeScript grammar.
  const name = `fn${String(index).padStart(6, '0')}`;
  return [
    `// fixture file ${index}`,
    `export function ${name}(value: number): number {`,
    `  const doubled = value * 2;`,
    `  return doubled + ${index % 97};`,
    `}`,
    ``,
    `export const ${name}Const = ${index};`,
    ``,
  ].join('\n');
}

function relativePath(index) {
  // Spread across directories so the walk is filesystem-realistic.
  const shard = String(Math.floor(index / 1000)).padStart(3, '0');
  const name = `f${String(index).padStart(6, '0')}.ts`;
  return join('src', shard, name);
}

const { files, out } = parseArgs(process.argv.slice(2));

if (existsSync(out)) {
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

for (let i = 0; i < files; i += 1) {
  const rel = relativePath(i);
  const absolute = join(out, rel);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contentFor(i));
  if ((i + 1) % 10_000 === 0) {
    console.error(`wrote ${i + 1} / ${files}`);
  }
}

writeFileSync(
  join(out, 'README.md'),
  `# Large fixture\n\nGenerated ${files} TypeScript files for ingest benchmarks.\n`
);

console.error(`wrote ${files} files under ${out}`);
