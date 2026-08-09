#!/usr/bin/env node
/**
 * Gate 0: an issue may not be picked up by an agent until its specification is
 * complete.
 *
 * The premise of the delivery system is that an agent reads only the issue and
 * its linked spec. Anything vague here becomes an invented interface later, so
 * this check is deliberately strict about placeholders and empty sections.
 */

import { execFileSync } from 'node:child_process';

const REQUIRED_SECTIONS = [
  'Epic',
  'Context',
  'Contract',
  'Files',
  'Acceptance Criteria',
  'Required Tests',
  'Performance Budget',
  'Out of Scope',
  'Dependencies',
  'Verification',
];

/** Text that means the author left the template untouched. */
const PLACEHOLDER = /^(_no response_|n\/a|tbd|todo|\.\.\.|-)$/i;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/** Split a GitHub issue-form body into `### Heading` sections. */
function parseSections(body) {
  const sections = new Map();
  let heading = null;
  let buffer = [];

  for (const line of body.split('\n')) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (heading) sections.set(heading, buffer.join('\n').trim());
      heading = match[1];
      buffer = [];
    } else if (heading) {
      buffer.push(line);
    }
  }
  if (heading) sections.set(heading, buffer.join('\n').trim());
  return sections;
}

function validate(sections, body) {
  const problems = [];

  for (const name of REQUIRED_SECTIONS) {
    const value = sections.get(name);
    if (value === undefined) {
      problems.push(`Missing section: **${name}**`);
      continue;
    }
    const stripped = value.replace(/```[a-z]*\n?|```/g, '').trim();
    if (stripped.length === 0 || PLACEHOLDER.test(stripped)) {
      problems.push(`Section **${name}** is empty or still a placeholder.`);
    }
  }

  // "Performance Budget" may legitimately be n/a; the others may not.
  const perf = sections.get('Performance Budget');
  if (perf && /^n\/a$/i.test(perf.trim())) {
    const idx = problems.findIndex((p) => p.includes('Performance Budget'));
    if (idx >= 0) problems.splice(idx, 1);
  }

  const acceptance = sections.get('Acceptance Criteria') ?? '';
  const boxes = (acceptance.match(/^\s*-\s*\[[ x]\]/gim) ?? []).length;
  if (boxes < 2) {
    problems.push(
      'Acceptance Criteria needs at least two checkbox items, each a single observable behaviour.'
    );
  }

  const files = sections.get('Files') ?? '';
  if (!/\b(CREATE|MODIFY|DELETE)\b/.test(files)) {
    problems.push('Files must mark each path as CREATE, MODIFY, or DELETE.');
  }

  const tests = sections.get('Required Tests') ?? '';
  if (tests.split('\n').filter((l) => l.trim().length > 0).length < 2) {
    problems.push('Required Tests must name at least two cases, including a failure or edge case.');
  }

  const epic = sections.get('Epic') ?? '';
  if (!/#\d+/.test(epic)) {
    problems.push('Epic must reference the tracking issue, for example `#3`.');
  }

  const deps = sections.get('Dependencies') ?? '';
  if (!/#\d+/.test(deps) && !/^none$/i.test(deps.trim())) {
    problems.push('Dependencies must list blocking issues or state `none`.');
  }

  if (!/tier:[123]/.test(body)) {
    problems.push('A risk tier must be selected.');
  }
  if (!/size:[sml]\b/.test(body)) {
    problems.push('A size must be selected.');
  }

  return problems;
}

function main() {
  const issueNumber = process.env.ISSUE_NUMBER;
  const repo = process.env.REPO;
  if (!issueNumber || !repo) {
    console.error('ISSUE_NUMBER and REPO are required.');
    return 1;
  }

  const issue = JSON.parse(
    gh(['issue', 'view', issueNumber, '--repo', repo, '--json', 'body,labels,title'])
  );
  const body = issue.body ?? '';
  const problems = validate(parseSections(body), body);

  const labels = new Set((issue.labels ?? []).map((l) => l.name));
  const setLabels = (add, remove) => {
    const args = ['issue', 'edit', issueNumber, '--repo', repo];
    for (const l of add) if (!labels.has(l)) args.push('--add-label', l);
    for (const l of remove) if (labels.has(l)) args.push('--remove-label', l);
    if (args.length > 5) gh(args);
  };

  if (problems.length === 0) {
    setLabels(['agent-ready'], ['needs-spec']);
    console.log('Specification is complete. Labelled `agent-ready`.');
    return 0;
  }

  setLabels(['needs-spec'], ['agent-ready']);
  const comment = [
    '**Gate 0 - Issue Readiness: not yet startable**',
    '',
    'An agent will read only this issue and its linked spec, so every gap below',
    'becomes a guess in the delivered code.',
    '',
    ...problems.map((p) => `- ${p}`),
    '',
    'Edit the issue to resolve these and this check will re-run automatically.',
  ].join('\n');

  gh(['issue', 'comment', issueNumber, '--repo', repo, '--body', comment]);
  console.log(problems.map((p) => `::error::${p}`).join('\n'));
  return 1;
}

process.exit(main());
