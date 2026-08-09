#!/usr/bin/env node
/**
 * Create or update agent-ready issues from the files in docs/issues.
 *
 * Issues are written as files rather than typed into the GitHub UI so that the
 * work contract is reviewable in a pull request, diffable when it changes, and
 * reproducible if the repository is ever recreated. The agent that picks up an
 * issue reads only the issue text, so the text is the specification and belongs
 * under version control with everything else.
 *
 * Matching is by title. Running this twice updates rather than duplicates.
 *
 *   node scripts/gh/seed-issues.mjs [--dry-run] [--epic <n>]
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSections, validate } from '../ci/check-issue-spec.mjs';

const ISSUES_DIR = 'docs/issues';
const REPO = 'johnbekele/infracanvas';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const epicFilter = args.includes('--epic') ? args[args.indexOf('--epic') + 1] : null;

function gh(argv) {
  return execFileSync('gh', argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** Keys whose value is a comma separated list. Everything else stays a string,
 * so a title containing a comma is not silently torn into fragments. */
const LIST_KEYS = new Set(['labels', 'assignees']);

/**
 * Parse the `---` delimited header. A full YAML parser would be a dependency
 * for no benefit: the header is a handful of scalars and one list.
 */
function parseFile(path) {
  const raw = readFileSync(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${path}: missing --- frontmatter block`);

  const meta = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) throw new Error(`${path}: cannot parse frontmatter line "${line}"`);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = LIST_KEYS.has(key)
      ? value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
      : value;
  }

  if (!meta.title) throw new Error(`${path}: frontmatter needs a title`);
  return { meta, body: match[2].trim(), path };
}

function collect() {
  const files = [];
  for (const epicDir of readdirSync(ISSUES_DIR).sort()) {
    const dir = join(ISSUES_DIR, epicDir);
    if (!statSync(dir).isDirectory()) continue;
    if (epicFilter && !epicDir.startsWith(`epic-${epicFilter}`)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.md')) files.push(parseFile(join(dir, name)));
    }
  }
  return files;
}

function main() {
  const specs = collect();
  if (specs.length === 0) {
    console.log(epicFilter ? `No issue files for epic ${epicFilter}.` : 'No issue files found.');
    return 0;
  }

  // Run Gate 0's own rules first. Creating an issue only to have the gate
  // immediately label it needs-spec wastes a round trip and leaves noise on the
  // issue, so the same check runs here against the file.
  let invalid = 0;
  for (const { meta, body, path } of specs) {
    const problems = validate(parseSections(body), body);
    if (problems.length > 0) {
      invalid += 1;
      console.error(`\n${path}  (${meta.title})`);
      for (const problem of problems) console.error(`  - ${problem}`);
    }
  }
  if (invalid > 0) {
    console.error(`\n${invalid} spec file(s) would be rejected by Gate 0. Nothing was created.`);
    return 1;
  }

  const existing = new Map(
    JSON.parse(gh(['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title'])).map(
      (i) => [i.title, i.number]
    )
  );

  let created = 0;
  let updated = 0;

  for (const { meta, body, path } of specs) {
    const labels = [].concat(meta.labels ?? []).filter(Boolean);
    const number = existing.get(meta.title);

    if (dryRun) {
      console.log(`${number ? 'update' : 'create'}  ${meta.title}  (${path})`);
      continue;
    }

    if (number) {
      const argv = ['issue', 'edit', String(number), '--repo', REPO, '--body', body];
      for (const label of labels) argv.push('--add-label', label);
      gh(argv);
      console.log(`updated #${number}  ${meta.title}`);
      updated += 1;
    } else {
      const argv = ['issue', 'create', '--repo', REPO, '--title', meta.title, '--body', body];
      for (const label of labels) argv.push('--label', label);
      const url = gh(argv).trim();
      console.log(`created ${url}  ${meta.title}`);
      created += 1;
    }
  }

  if (!dryRun) {
    console.log(`\n${created} created, ${updated} updated.`);
    console.log('Gate 0 will label each one agent-ready or needs-spec.');
  }
  return 0;
}

process.exit(main());
