#!/usr/bin/env node
/**
 * Run locally what Gates 2 and 3 run in CI, in one command.
 *
 * An agent loop is only as fast as its feedback. Without this, the first honest
 * verdict on a change arrives minutes after a push, from a pull request that is
 * already open — so a formatting slip costs a full CI round trip and a force
 * push. The commands below are copied from `.github/workflows/gate-static.yml`
 * and `gate-test.yml` rather than reinvented, so a local pass means the same
 * thing CI means.
 *
 * By default every step runs even after one fails, and the summary lists all of
 * them. Stopping at the first failure would hide the other four and turn one
 * round trip into five. Use --bail when you want the opposite.
 *
 * Toolchains that are not installed are reported as skipped rather than failed:
 * CI still checks them, and pretending otherwise would teach you to read a red
 * summary as noise. A skip is only safe if you did not touch that language.
 *
 *   node scripts/ci/verify-local.mjs [--fast] [--integration] [--bail] [--list]
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const withIntegration = args.includes('--integration');
const bail = args.includes('--bail');
const listOnly = args.includes('--list');

const BASE_REF = process.env.VERIFY_BASE_REF ?? 'origin/main';

const hasPython = existsSync('services/brain/pyproject.toml');
const hasRust = existsSync('Cargo.toml');

/** Is a binary on PATH? Used to skip rather than fail on a missing toolchain. */
function available(bin) {
  return spawnSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }).status === 0;
}

/**
 * Every step: a label for the summary, the command, and optionally a `when`
 * that decides between running and skipping with a stated reason.
 */
function steps() {
  const list = [];

  // --- Gate 2: Static ------------------------------------------------------
  list.push({
    gate: 2,
    name: 'Format (prettier)',
    cmd: ['pnpm', ['exec', 'prettier', '--check', '**/*.{ts,tsx,js,jsx,json,md,yml,yaml}']],
  });
  list.push({
    gate: 2,
    name: 'ESLint',
    cmd: ['pnpm', ['exec', 'eslint', '.', '--max-warnings=0']],
  });

  // Typecheck needs the workspace dependency built first; CI does the same, and
  // without it tsc fails on missing @infracanvas/core types rather than on the
  // change under review.
  list.push({
    gate: 2,
    name: 'Build workspace deps',
    cmd: ['pnpm', ['turbo', 'build', '--filter=@infracanvas/core']],
  });
  list.push({ gate: 2, name: 'Typecheck (tsc)', cmd: ['pnpm', ['turbo', 'typecheck']] });

  // The Python steps need the virtualenv populated first, exactly as every Python
  // job in CI does before it runs anything. Without it `uv run pytest` collects
  // nothing and reports `No module named 'brain'` — a missing environment wearing
  // the costume of a broken import, which is a bad first impression in a worktree
  // someone has just created.
  list.push({
    gate: 2,
    name: 'Sync Python deps',
    cmd: ['uv', ['sync', '--directory', 'services/brain', '--all-extras']],
    when: pythonGuard(),
  });
  list.push({
    gate: 2,
    name: 'Ruff format',
    cmd: ['uv', ['run', '--directory', 'services/brain', 'ruff', 'format', '--check', '.']],
    when: pythonGuard(),
  });
  list.push({
    gate: 2,
    name: 'Ruff lint',
    cmd: ['uv', ['run', '--directory', 'services/brain', 'ruff', 'check', '.']],
    when: pythonGuard(),
  });
  list.push({
    gate: 2,
    name: 'Mypy strict',
    cmd: ['uv', ['run', '--directory', 'services/brain', 'mypy', '--strict', 'src']],
    when: pythonGuard(),
  });

  list.push({
    gate: 2,
    name: 'Rustfmt',
    cmd: ['cargo', ['fmt', '--all', '--check']],
    when: rustGuard(),
  });
  list.push({
    gate: 2,
    name: 'Clippy',
    cmd: ['cargo', ['clippy', '--all-targets', '--all-features', '--', '-Dwarnings']],
    when: rustGuard(),
  });

  if (fast) return list;

  list.push({
    gate: 2,
    name: 'Forbidden patterns',
    cmd: ['node', ['scripts/ci/check-forbidden-patterns.mjs', BASE_REF]],
  });

  // --- Gate 3: Test --------------------------------------------------------
  list.push({ gate: 3, name: 'Unit tests (TypeScript)', cmd: ['pnpm', ['turbo', 'test']] });
  list.push({
    gate: 3,
    name: 'Unit tests (Python)',
    cmd: ['uv', ['run', '--directory', 'services/brain', 'pytest', '-m', 'not integration']],
    when: pythonGuard(),
  });
  list.push({
    gate: 3,
    name: 'Unit tests (Rust)',
    cmd: ['cargo', ['test', '--all-features', '--workspace']],
    when: rustGuard(),
  });

  if (withIntegration) {
    list.push({
      gate: 3,
      name: 'Integration tests',
      cmd: ['pnpm', ['turbo', 'test:integration']],
      when: !process.env.DATABASE_URL
        ? 'DATABASE_URL is not set; start Postgres with pnpm db:up and export it'
        : true,
    });
  }

  return list;
}

function pythonGuard() {
  if (!hasPython) return 'services/brain/pyproject.toml does not exist yet';
  if (!available('uv')) return 'uv is not installed; CI will still check Python';
  return true;
}

function rustGuard() {
  if (!hasRust) return 'no Cargo workspace yet';
  if (!available('cargo')) return 'cargo is not installed; CI will still check Rust';
  return true;
}

function main() {
  const all = steps();
  const results = [];

  console.log(
    `\nVerifying against ${BASE_REF}${fast ? ' (fast: static only)' : ''}${
      withIntegration ? ' (with integration)' : ''
    }\n`
  );

  if (listOnly) {
    for (const step of all) {
      const guard = step.when ?? true;
      const [bin, argv] = step.cmd;
      const label = guard === true ? 'run ' : 'skip';
      console.log(`${label}  Gate ${step.gate}  ${step.name}`);
      console.log(`        ${bin} ${argv.join(' ')}`);
      if (guard !== true) console.log(`        reason: ${guard}`);
    }
    return 0;
  }

  for (const step of all) {
    const guard = step.when ?? true;
    if (guard !== true) {
      results.push({ ...step, status: 'skip', reason: guard });
      console.log(`\u2013 SKIP  Gate ${step.gate}  ${step.name}  (${guard})`);
      continue;
    }

    console.log(`\u25b6 RUN   Gate ${step.gate}  ${step.name}`);
    const [bin, argv] = step.cmd;
    const { status } = spawnSync(bin, argv, { stdio: 'inherit' });
    const ok = status === 0;
    results.push({ ...step, status: ok ? 'pass' : 'fail' });
    console.log(ok ? `\u2713 PASS  ${step.name}\n` : `\u2717 FAIL  ${step.name}\n`);
    if (!ok && bail) break;
  }

  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  const passed = results.filter((r) => r.status === 'pass');

  console.log('\u2500'.repeat(64));
  for (const r of results) {
    const mark = r.status === 'pass' ? '\u2713' : r.status === 'fail' ? '\u2717' : '\u2013';
    console.log(`${mark} ${r.name}${r.reason ? `  (${r.reason})` : ''}`);
  }
  console.log('\u2500'.repeat(64));
  console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped.`);

  if (failed.length > 0) {
    console.error('\nCI would reject this. Fix the failures above before pushing.');
    return 1;
  }
  if (fast) {
    console.log('\nStatic checks pass. Run the full `pnpm verify` before you push.');
  } else {
    console.log(
      '\nThis is what CI will see. Gates 4-6 (drift, security, budgets) still run there.'
    );
  }
  return 0;
}

process.exit(main());
