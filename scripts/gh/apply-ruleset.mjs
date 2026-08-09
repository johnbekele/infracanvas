#!/usr/bin/env node
/**
 * Apply `.github/rulesets/main.json` to the repository.
 *
 * Keeping branch protection in version control means the rules of the project
 * are reviewable in a pull request rather than being clicked into a settings
 * page and forgotten.
 *
 * Usage: node scripts/gh/apply-ruleset.mjs [--repo owner/name] [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RULESET_PATH = '.github/rulesets/main.json';

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const repoIndex = args.indexOf('--repo');
  const repo =
    repoIndex >= 0
      ? args[repoIndex + 1]
      : JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;

  const desired = JSON.parse(readFileSync(RULESET_PATH, 'utf8'));

  const existing = JSON.parse(gh(['api', `repos/${repo}/rulesets`]));
  const match = existing.find((r) => r.name === desired.name);

  if (dryRun) {
    console.log(`[dry-run] would ${match ? `update ruleset ${match.id}` : 'create ruleset'} on ${repo}`);
    console.log(JSON.stringify(desired, null, 2));
    return;
  }

  // gh api reads a JSON body from a file to avoid shell quoting problems with
  // the nested rule parameters.
  const tmp = join(mkdtempSync(join(tmpdir(), 'ruleset-')), 'ruleset.json');
  writeFileSync(tmp, JSON.stringify(desired));

  const endpoint = match ? `repos/${repo}/rulesets/${match.id}` : `repos/${repo}/rulesets`;
  const method = match ? 'PUT' : 'POST';

  gh(['api', '--method', method, endpoint, '--input', tmp]);
  console.log(`${match ? 'Updated' : 'Created'} ruleset "${desired.name}" on ${repo}.`);

  const checks = desired.rules.find((r) => r.type === 'required_status_checks');
  console.log(`Required status checks: ${checks?.parameters.required_status_checks.length ?? 0}`);
  console.log(
    '\nNote: a required check only becomes enforceable once a workflow has reported it at least once.'
  );
}

main();
