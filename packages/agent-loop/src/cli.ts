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
 */

import { join } from 'node:path';

import { ClaudeAdapter } from './agents/claude';
import { CodexAdapter } from './agents/codex';
import { CursorAdapter } from './agents/cursor';
import type { AgentAdapter } from './agents';
import { ClaimStore } from './claim';
import { defaultConfig } from './config';
import { GitHub } from './gh';
import * as log from './log';
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
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { once: false, noMerge: false, status: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') args.once = true;
    else if (arg === '--no-merge') args.noMerge = true;
    else if (arg === '--status') args.status = true;
    else if (arg === '--lane') {
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

  if (args.explain !== undefined) {
    const supervisor = buildSupervisor(config, github, mainCheckout);
    log.info(await supervisor.explain(args.explain));
    return 0;
  }

  const supervisor = buildSupervisor(config, github, mainCheckout);
  const runOptions = { onlyLane: args.lane, onlyIssue: args.issue, noMerge: args.noMerge };
  // Pinning a single issue is only ever a controlled one-shot; never loop on it.
  const once = args.once || args.issue !== undefined;

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

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
