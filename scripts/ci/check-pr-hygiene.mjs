#!/usr/bin/env node
/**
 * Gate 7: verify the pull request carries the evidence a reviewer needs.
 *
 * The checklist is not ceremony. Each item maps to a failure mode we would
 * otherwise only discover after merge, so an unticked box blocks the merge queue.
 */

import { execFileSync } from 'node:child_process';

const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .{1,80}$/;

const REQUIRED_CHECKLIST = [
  'Scope matches the issue',
  'Every acceptance criterion has a corresponding test',
  'Every named test',
  'Performance budget measured',
  'No secrets, keys, tokens',
  'Public API changes are reflected',
  'No AI or assistant co-author trailers',
];

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const { PR_NUMBER, REPO, BASE_REF = 'main' } = process.env;
  if (!PR_NUMBER || !REPO) {
    console.error('PR_NUMBER and REPO are required.');
    return 1;
  }

  const pr = JSON.parse(
    gh(['pr', 'view', PR_NUMBER, '--repo', REPO, '--json', 'title,body,labels,isDraft'])
  );

  if (pr.isDraft) {
    console.log('Draft pull request; hygiene checks are deferred until it is ready for review.');
    return 0;
  }

  const body = pr.body ?? '';
  const problems = [];
  const warnings = [];

  if (!CONVENTIONAL.test(pr.title)) {
    problems.push(
      `Title must follow Conventional Commits, for example \`feat(rag): add BM25 retriever\`. Got: "${pr.title}"`
    );
  }

  if (!/\b(closes|fixes|resolves)\s+#\d+/i.test(body)) {
    problems.push('Body must close an issue, for example `Closes #42`. Untracked work is invisible work.');
  }

  for (const item of REQUIRED_CHECKLIST) {
    const line = body
      .split('\n')
      .find((l) => l.includes(item) && /^\s*-\s*\[[ x]\]/i.test(l));
    if (!line) {
      problems.push(`Checklist item missing from the body: "${item}"`);
    } else if (!/^\s*-\s*\[x\]/i.test(line)) {
      problems.push(`Checklist item not ticked: "${item}"`);
    }
  }

  const tiers = (body.match(/^\s*-\s*\[x\]\s*\*\*Tier [123]\*\*/gim) ?? []).length;
  if (tiers === 0) problems.push('Select exactly one risk tier.');
  if (tiers > 1) problems.push('Select exactly one risk tier; multiple are ticked.');

  const verification = /## Verification\s*\n+([\s\S]*?)(?:\n## |$)/.exec(body)?.[1] ?? '';
  const fenced = /```[\s\S]*?```/.exec(verification)?.[0] ?? '';
  if (fenced.replace(/```/g, '').trim().length === 0) {
    problems.push(
      'Paste the actual output of the Verification commands. "Tests pass" is not evidence.'
    );
  }

  // Size is advisory: large diffs are sometimes unavoidable, but they should be
  // a conscious choice rather than an accident.
  try {
    const base = git(['merge-base', 'HEAD', `origin/${BASE_REF}`]).trim();
    const stat = git(['diff', '--numstat', `${base}...HEAD`]);
    let changed = 0;
    for (const line of stat.trim().split('\n')) {
      const [add, del, file] = line.split('\t');
      if (!file) continue;
      if (/(pnpm-lock\.yaml|Cargo\.lock|uv\.lock|\.snap$|fixtures?\/)/.test(file)) continue;
      changed += (Number.parseInt(add, 10) || 0) + (Number.parseInt(del, 10) || 0);
    }
    if (changed > 600) {
      warnings.push(
        `Diff is ${changed} lines excluding lockfiles and fixtures. Issues are meant to be under 600; consider splitting.`
      );
    }
  } catch {
    // Shallow checkout; size advice is optional.
  }

  for (const w of warnings) console.log(`::warning::${w}`);

  if (problems.length === 0) {
    console.log('PR hygiene passed.');
    return 0;
  }

  for (const p of problems) console.log(`::error::${p}`);
  console.log(`\n${problems.length} problem(s) must be resolved before this can merge.`);
  return 1;
}

process.exit(main());
