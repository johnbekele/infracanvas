#!/usr/bin/env node
/**
 * Gate 2: scan added lines for patterns that erode the codebase over time.
 *
 * Only added lines are inspected, so existing debt never blocks an unrelated PR.
 * Each rule can be waived on a specific line with a trailing
 * `infracanvas-allow: <rule-id>` comment, which keeps the escape hatch visible
 * in review rather than hidden in a config file.
 */

import { execFileSync } from 'node:child_process';

const RULES = [
  {
    id: 'no-any',
    // `: any`, `as any`, `<any>`, `any[]`, `Array<any>`, `Promise<any>`
    pattern: /(:\s*any\b|\bas\s+any\b|<any>|\bany\[\]|\b(?:Array|Promise|Record)<[^>]*\bany\b)/,
    files: /\.(ts|tsx)$/,
    message: 'The `any` type defeats the type system. Use a precise type, `unknown`, or a generic.',
  },
  {
    id: 'no-blanket-type-ignore',
    pattern: /#\s*type:\s*ignore\s*(?!\[)/,
    files: /\.py$/,
    message: 'Bare `# type: ignore` hides every error on the line. Use `# type: ignore[code]`.',
  },
  {
    id: 'no-unwrap',
    pattern: /\.(unwrap|expect)\s*\(/,
    files: /\.rs$/,
    excludeFiles: /(tests?\/|_test\.rs$|\/benches\/)/,
    message: 'Panicking on error crashes the indexer mid-run. Return a `Result` instead.',
  },
  {
    id: 'no-console',
    pattern: /\bconsole\.(log|debug|dir)\s*\(/,
    files: /\.(ts|tsx)$/,
    excludeFiles: /(scripts\/|\.test\.|\.spec\.|\/tests?\/)/,
    message: 'Use the structured logger so output stays parseable in production.',
  },
  {
    id: 'no-debugger',
    pattern: /\bdebugger\s*;?/,
    files: /\.(ts|tsx|js|mjs)$/,
    message: 'A `debugger` statement halts the browser for every user.',
  },
  {
    id: 'no-untracked-todo',
    // A TODO is acceptable only when it links to an issue that can outlive the author.
    pattern: /\b(TODO|FIXME|XXX|HACK)\b(?!.*#\d+)/,
    files: /\.(ts|tsx|py|rs|sql|mjs)$/,
    message: 'Reference an issue, for example `TODO(#123): ...`, or resolve it now.',
  },
  {
    id: 'no-hardcoded-region',
    pattern: /["'](us-east-1|us-west-2|eu-west-1|eu-central-1)["']/,
    files: /\.(ts|tsx|py)$/,
    excludeFiles: /(\.test\.|\.spec\.|\/tests?\/|fixtures?\/|pricing\/)/,
    message: 'Region must come from configuration. A hardcoded region breaks multi-region users.',
  },
];

/** Commit trailers that attribute authorship to an assistant, forbidden by CLAUDE.md. */
const FORBIDDEN_TRAILERS = /^(Co-Authored-By:\s*(Claude|Cursor|Copilot|AI\b)|Generated with)/im;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const base = process.argv[2] || 'origin/main';

  let mergeBase;
  try {
    mergeBase = git(['merge-base', 'HEAD', base]).trim();
  } catch {
    console.log(`Cannot resolve merge base against ${base}; skipping.`);
    return 0;
  }

  const violations = [];

  // --- Added-line rules ------------------------------------------------------
  const diff = git(['diff', '--unified=0', `${mergeBase}...HEAD`]);
  let currentFile = null;
  let lineNo = 0;

  for (const line of diff.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      lineNo = Number.parseInt(hunkMatch[1], 10);
      continue;
    }
    if (!currentFile || !line.startsWith('+') || line.startsWith('+++')) continue;

    const content = line.slice(1);
    const position = lineNo;
    lineNo += 1;

    if (content.includes('infracanvas-allow:')) {
      const waived = content.slice(content.indexOf('infracanvas-allow:') + 18).trim();
      if (RULES.some((r) => waived.startsWith(r.id))) continue;
    }

    for (const rule of RULES) {
      if (!rule.files.test(currentFile)) continue;
      if (rule.excludeFiles?.test(currentFile)) continue;
      if (!rule.pattern.test(content)) continue;
      violations.push({
        file: currentFile,
        line: position,
        rule: rule.id,
        message: rule.message,
        snippet: content.trim().slice(0, 120),
      });
    }
  }

  // --- Commit trailer rule ---------------------------------------------------
  const log = git(['log', '--format=%B%x00', `${mergeBase}..HEAD`]);
  for (const message of log.split('\0')) {
    if (FORBIDDEN_TRAILERS.test(message)) {
      violations.push({
        file: '<commit message>',
        line: 0,
        rule: 'no-ai-attribution',
        message: 'Commits must not carry assistant co-author or generation trailers.',
        snippet: message.split('\n').find((l) => FORBIDDEN_TRAILERS.test(l))?.trim() ?? '',
      });
    }
  }

  if (violations.length === 0) {
    console.log('Forbidden pattern scan passed.');
    return 0;
  }

  for (const v of violations) {
    console.log(`::error file=${v.file},line=${v.line}::[${v.rule}] ${v.message}\n    ${v.snippet}`);
  }
  console.log(`\n${violations.length} violation(s) found.`);
  console.log('Waive a justified case with a trailing `infracanvas-allow: <rule-id>` comment.');
  return 1;
}

process.exit(main());
