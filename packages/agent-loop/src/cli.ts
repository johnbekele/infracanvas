/**
 * The entry point. Wiring only: parse a few flags, build the real dependencies,
 * and hand off to the supervisor. All the logic worth testing lives in the
 * modules this imports, not here.
 *
 * Usage:
 *   pnpm loop                     run continuously until the queue empties or .agent-loop/stop appears
 *   pnpm loop --once              a single scheduling pass, then exit
 *   pnpm loop --lane B            restrict to one lane
 *   pnpm loop --issue 96          restrict to a single issue (implies --once), for a controlled dry run
 *   pnpm loop --no-merge          get PRs green and mergeable, but do not merge (dry run)
 *   pnpm loop --status            print the current run snapshots and exit
 *   pnpm loop --explain 202       say whether issue #202 is eligible, and why not
 *   pnpm loop --merge-train       drain the open PR backlog: update, wait for green CI, squash-merge
 *     --dry-run                     with --merge-train: show the plan, change nothing
 *     --include-tier1               with --merge-train: also merge tier:1 / needs:security-review, unreviewed
 *     --include-deps                with --merge-train: also merge dependabot PRs
 *     --prs 1,2,3                   with --merge-train: attempt exactly these numbers, ignoring the label filters
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ClaudeAdapter } from './agents/claude';
import { CodexAdapter } from './agents/codex';
import { CursorAdapter } from './agents/cursor';
import type { AgentAdapter } from './agents';
import { ClaimStore } from './claim';
import { defaultConfig } from './config';
import { GitHub } from './gh';
import * as log from './log';
import { runMergeTrain } from './merge-train';
import { FileMutex } from './mutex';
import { readSnapshots } from './report';
import { Supervisor } from './supervisor';
import type { Lane } from './types';
import { Worktrees, mainCheckoutPath } from './worktree';

interface Args {
  once: boolean;
  noMerge: boolean;
  status: boolean;
  lane?: Lane;
  issue?: number;
  explain?: number;
  mergeTrain: boolean;
  dryRun: boolean;
  includeTier1: boolean;
  includeDeps: boolean;
  prs?: number[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    once: false,
    noMerge: false,
    status: false,
    mergeTrain: false,
    dryRun: false,
    includeTier1: false,
    includeDeps: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') args.once = true;
    else if (arg === '--no-merge') args.noMerge = true;
    else if (arg === '--status') args.status = true;
    else if (arg === '--merge-train') args.mergeTrain = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--include-tier1') args.includeTier1 = true;
    else if (arg === '--include-deps') args.includeDeps = true;
    else if (arg === '--prs') {
      const value = argv[++i] ?? '';
      args.prs = value
        .split(',')
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      if (args.prs.length === 0) throw new Error('--prs needs a comma-separated list of numbers');
    } else if (arg === '--lane') {
      const value = argv[++i];
      if (value === 'A' || value === 'B' || value === 'C') args.lane = value;
      else throw new Error(`--lane must be A, B, or C, got "${value}"`);
    } else if (arg === '--issue') {
      args.issue = Number.parseInt(argv[++i], 10);
      if (Number.isNaN(args.issue)) throw new Error('--issue needs an issue number');
    } else if (arg === '--explain') {
      args.explain = Number.parseInt(argv[++i], 10);
      if (Number.isNaN(args.explain)) throw new Error('--explain needs an issue number');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const mainCheckout = await mainCheckoutPath(process.cwd());
  const config = defaultConfig({ stateDir: join(mainCheckout, '.agent-loop') });

  if (args.status) {
    const snapshots = readSnapshots(join(config.stateDir, 'runs'));
    if (snapshots.length === 0) {
      log.info('no runs recorded yet');
      return 0;
    }
    for (const s of snapshots) {
      const pr = s.prNumber ? ` PR#${s.prNumber}` : '';
      log.info(`#${s.issue} [${s.lane}/${s.agent}] ${s.status}${pr}  ${s.branch}`);
    }
    return 0;
  }

  const github = new GitHub(config.repo);

  if (args.mergeTrain) {
    const results = await runMergeTrain(github, {
      filter: {
        baseBranch: 'main',
        includeTier1: args.includeTier1,
        includeDeps: args.includeDeps,
        // The autonomous issue loop merges its own PRs; the train leaves them be.
        includeAgentLoop: false,
        onlyNumbers: args.prs,
      },
      dryRun: args.dryRun,
      // Feature branches carry the full gate suite, so give CI a generous budget;
      // a check that is still pending after this is treated as not settling.
      ciTimeoutMs: 30 * 60 * 1000,
      ciPollMs: 30 * 1000,
      settleTimeoutMs: 90 * 1000,
      rerunSettleMs: 30 * 1000,
      maxSyncs: 4,
    });
    const merged = results.filter((r) => r.outcome === 'merged').length;
    log.info(`merge train done: ${merged}/${results.length} merged`);
    return 0;
  }

  if (args.explain !== undefined) {
    const supervisor = buildSupervisor(config, github, mainCheckout);
    log.info(await supervisor.explain(args.explain));
    return 0;
  }

  const supervisor = buildSupervisor(config, github, mainCheckout);
  const runOptions = { onlyLane: args.lane, onlyIssue: args.issue, noMerge: args.noMerge };
  // Pinning a single issue is only ever a controlled one-shot; never loop on it.
  const once = args.once || args.issue !== undefined;

  // Record the pid so the dashboard's "running" indicator is accurate however the
  // loop was started — from the board or from a terminal — and so a second start
  // can refuse when one is already up. Removed on exit, but only if still ours, so
  // a crash-and-restart does not delete the successor's file.
  writePidFile(join(config.stateDir, 'loop.pid'));

  // A signal skips the per-issue finally blocks, so release held claims and
  // remove their trees here before exiting, or an interrupted run strands its
  // issues behind a status:in-progress label.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.warn(`received ${signal}; releasing claims before exit`);
      void supervisor.shutdown().finally(() => process.exit(130));
    });
  }

  log.banner(
    `InfraCanvas agent loop\n` +
      `  repo        ${config.repo}\n` +
      `  lanes       ${describeLanes(config.laneAgents)}\n` +
      `  merge       ${config.mergeAllTiers ? 'all tiers, unattended' : 'never (report only)'}\n` +
      `  integration ${config.integration ? 'on' : 'off (set DATABASE_URL to enable)'}\n` +
      `  kill switch ${config.killSwitch}`
  );

  if (once) {
    const outcomes = await supervisor.runOnce(runOptions);
    for (const [issue, outcome] of outcomes) log.info(`#${issue}: ${outcome}`);
    return 0;
  }

  await supervisor.runForever(runOptions);
  return 0;
}

function buildSupervisor(
  config: ReturnType<typeof defaultConfig>,
  github: GitHub,
  mainCheckout: string
): Supervisor {
  const adapters: Record<Lane, AgentAdapter> = {
    A: new ClaudeAdapter(),
    B: new CodexAdapter(),
    C: new CursorAdapter(),
  };
  return new Supervisor(config, {
    github,
    worktrees: new Worktrees(mainCheckout),
    claims: new ClaimStore(config.stateDir, github, config.assignee),
    adapters,
    integrationMutex: new FileMutex(config.stateDir, 'integration'),
    // A short lease: worktree setup is seconds, so a lock older than this is a
    // crashed lane, not a slow one, and must not wedge the other two.
    worktreeMutex: new FileMutex(config.stateDir, 'worktree', 5 * 60 * 1000),
  });
}

function describeLanes(laneAgents: Record<Lane, string>): string {
  return (['A', 'B', 'C'] as Lane[]).map((l) => `${l}=${laneAgents[l]}`).join(' ');
}

/** Write our pid, and arrange to clear it on exit if it is still ours. */
function writePidFile(path: string): void {
  writeFileSync(path, String(process.pid));
  process.on('exit', () => {
    try {
      if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path);
    } catch {
      // Already gone, or replaced by a successor: nothing to clean up.
    }
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
