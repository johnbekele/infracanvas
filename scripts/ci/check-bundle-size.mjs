#!/usr/bin/env node
/**
 * Gate 6: hold the initial JavaScript payload to its budget.
 *
 * Only entry chunks referenced by index.html count. Lazily-loaded route chunks
 * are excluded deliberately, because pushing weight behind a dynamic import is
 * exactly the behaviour this budget is meant to encourage.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function findHtml(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findHtml(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

function main() {
  const distDir = process.argv[2];
  const budgetKb = Number.parseInt(process.argv[3] ?? '250', 10);

  if (!distDir) {
    console.error('Usage: check-bundle-size.mjs <dist-dir> <budget-kb>');
    return 1;
  }

  let htmlFiles;
  try {
    htmlFiles = findHtml(distDir);
  } catch {
    console.log(`::notice::${distDir} not found; bundle size gate is inert.`);
    return 0;
  }

  const entries = new Set();
  for (const html of htmlFiles) {
    const content = readFileSync(html, 'utf8');
    for (const match of content.matchAll(/<script[^>]+src="([^"]+\.js)"/g)) {
      entries.add(match[1].replace(/^\//, ''));
    }
  }

  if (entries.size === 0) {
    console.log('::notice::No entry scripts found; nothing to measure.');
    return 0;
  }

  let total = 0;
  const rows = [];
  for (const entry of entries) {
    const path = join(distDir, entry);
    try {
      const gz = gzipSync(readFileSync(path)).length;
      total += gz;
      rows.push([relative(distDir, path), gz]);
    } catch {
      console.log(`::warning::Referenced entry not found on disk: ${entry}`);
    }
  }

  rows.sort((a, b) => b[1] - a[1]);
  for (const [name, size] of rows) {
    console.log(`  ${(size / 1024).toFixed(1).padStart(8)} KB gzip  ${name}`);
  }

  const totalKb = total / 1024;
  console.log(`\nInitial JS: ${totalKb.toFixed(1)} KB gzip (budget ${budgetKb} KB)`);

  if (totalKb > budgetKb) {
    console.log(
      `::error::Initial JS is ${totalKb.toFixed(1)} KB gzip, over the ${budgetKb} KB budget. Move non-critical code behind a dynamic import.`
    );
    return 1;
  }
  return 0;
}

process.exit(main());
