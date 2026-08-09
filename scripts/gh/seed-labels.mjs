#!/usr/bin/env node
/**
 * Create or update the canonical label set from `.github/labels.yml`.
 *
 * Idempotent: existing labels are updated in place, unknown labels are left
 * alone. Run after cloning, or whenever labels.yml changes.
 *
 * Usage: node scripts/gh/seed-labels.mjs [--repo owner/name] [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Minimal parser for the constrained shape used by labels.yml: a flat sequence
 * of maps with exactly the keys name, color, and description. Anything else is
 * rejected loudly rather than silently mis-parsed.
 */
function parseLabels(text) {
  const labels = [];
  let current = null;

  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) return;

    const item = /^-\s+name:\s*(.+)$/.exec(line);
    if (item) {
      if (current) labels.push(current);
      current = { name: unquote(item[1]) };
      return;
    }

    const field = /^\s+(color|description):\s*(.+)$/.exec(line);
    if (field) {
      if (!current) throw new Error(`labels.yml:${index + 1}: field before any list item`);
      current[field[1]] = unquote(field[2]);
      return;
    }

    throw new Error(`labels.yml:${index + 1}: unexpected line: ${line}`);
  });

  if (current) labels.push(current);

  for (const label of labels) {
    if (!label.color || !label.description) {
      throw new Error(`Label "${label.name}" is missing a color or description.`);
    }
  }
  return labels;
}

function unquote(value) {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const repoIndex = args.indexOf('--repo');
  const repo =
    repoIndex >= 0
      ? args[repoIndex + 1]
      : JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;

  const labels = parseLabels(readFileSync('.github/labels.yml', 'utf8'));

  const existing = new Set(
    JSON.parse(gh(['label', 'list', '--repo', repo, '--limit', '200', '--json', 'name'])).map(
      (l) => l.name
    )
  );

  let created = 0;
  let updated = 0;

  for (const label of labels) {
    const action = existing.has(label.name) ? 'update' : 'create';
    if (dryRun) {
      console.log(`[dry-run] ${action} ${label.name}`);
      continue;
    }
    const cmd = [
      'label',
      action === 'create' ? 'create' : 'edit',
      label.name,
      '--repo',
      repo,
      '--color',
      label.color.replace(/^#/, ''),
      '--description',
      label.description,
    ];
    if (action === 'create') cmd.push('--force');
    gh(cmd);
    if (action === 'create') {
      created += 1;
      console.log(`Created ${label.name}`);
    } else {
      updated += 1;
      console.log(`Updated ${label.name}`);
    }
  }

  console.log(`\n${labels.length} labels processed: ${created} created, ${updated} updated.`);
}

main();
