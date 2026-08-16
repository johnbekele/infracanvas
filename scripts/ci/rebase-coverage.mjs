#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT_MARKERS = new Set(['apps', 'packages', 'services', 'crates']);
const TAGS =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_:][^>]*>/g;

/** Rewrite one Cobertura report in place so its paths are repository-relative. */
export function rebase(xml, packageRoot) {
  assertParsableXml(xml);
  const root = normalizePath(packageRoot);

  return xml
    .replace(/<[^!?/][^>]*>/g, (tag) =>
      tag.replace(/(\bfilename\s*=\s*)(["'])(.*?)\2/g, (_match, prefix, quote, filename) => {
        return `${prefix}${quote}${rebasePath(filename, root)}${quote}`;
      })
    )
    .replace(/(<source\b[^>]*>)([^<]*)(<\/source>)/g, (_match, open, source, close) => {
      const value = source.trim();
      if (value === '') return `${open}${source}${close}`;

      const leading = source.match(/^\s*/)[0];
      const trailing = source.match(/\s*$/)[0];
      return `${open}${leading}${rebasePath(value, root)}${trailing}${close}`;
    });
}

export function inferPackageRoot(reportPath) {
  const segments = normalizePath(reportPath).split('/').filter(Boolean);
  const markerIndex = segments.findIndex((segment) => PACKAGE_ROOT_MARKERS.has(segment));
  if (markerIndex === -1) return '';

  const rooted = segments.slice(markerIndex);
  const coverageIndex = rooted.lastIndexOf('coverage');
  return (coverageIndex > 0 ? rooted.slice(0, coverageIndex) : rooted.slice(0, -1)).join('/');
}

function rebasePath(value, packageRoot) {
  const normalized = normalizePath(value);
  if (normalized === '') return value;

  const relative = repoRelativePath(normalized);
  if (packageRoot === '') return relative ?? normalized;
  if (normalized === packageRoot || normalized.startsWith(`${packageRoot}/`)) return normalized;
  if (relative !== null) return relative || '.';

  const marker = normalized.indexOf(`/${packageRoot}/`);
  if (marker !== -1) return normalized.slice(marker + 1);
  if (normalized.endsWith(`/${packageRoot}`)) return packageRoot;

  return `${packageRoot}/${normalized === '.' ? '' : normalized.replace(/^\/+/, '')}`.replace(
    /\/$/,
    ''
  );
}

function repoRelativePath(value) {
  const cwd = normalizePath(process.cwd());
  if (value === cwd) return '';
  if (value.startsWith(`${cwd}/`)) return value.slice(cwd.length + 1);
  return null;
}

function normalizePath(value) {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

function assertParsableXml(xml) {
  const stack = [];
  let cursor = 0;
  let sawTag = false;

  for (const match of xml.matchAll(TAGS)) {
    if (xml.slice(cursor, match.index).includes('<')) throw parseError();

    sawTag = true;
    cursor = match.index + match[0].length;
    const tag = match[0];
    if (tag.startsWith('<!--') || tag.startsWith('<!') || tag.startsWith('<?')) continue;

    const name = tag.match(/^<\/?([A-Za-z_:][A-Za-z0-9_.:-]*)\b/)?.[1];
    if (name === undefined) throw parseError();
    if (tag.startsWith('</')) {
      if (stack.pop() !== name) throw parseError();
    } else if (!/\/\s*>$/.test(tag)) {
      stack.push(name);
    }
  }

  if (!sawTag || xml.slice(cursor).includes('<') || stack.length > 0) throw parseError();
}

function parseError() {
  return new Error('Could not parse coverage XML');
}

function main(argv) {
  if (argv.length === 0) {
    console.error('Usage: node scripts/ci/rebase-coverage.mjs <coverage.xml>...');
    return 1;
  }

  for (const report of argv) {
    const xml = readFileSync(report, 'utf8');
    writeFileSync(report, rebase(xml, inferPackageRoot(report)));
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
