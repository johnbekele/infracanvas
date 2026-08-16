/**
 * The write side: start, stop, and release, the three irreversible things the
 * dashboard can do to the loop. Kept apart from the read source because these
 * spawn or signal a process and touch the claim files, and the routes gate them
 * more tightly than a read.
 *
 * The command spawned is fixed (`pnpm loop`) with no caller-supplied arguments,
 * so an enabled dashboard cannot be turned into arbitrary command execution.
 */

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveRepoRoot } from './config.js';

export class LoopAlreadyRunningError extends Error {
  constructor() {
    super('The loop is already running.');
    this.name = 'LoopAlreadyRunningError';
  }
}

function pidFilePath(stateDir: string): string {
  return join(stateDir, 'loop.pid');
}

/** The pid the API last recorded, if that process is still alive; else null. */
function runningPid(stateDir: string): number | null {
  const file = pidFilePath(stateDir);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM means the process exists but is owned by another user, which still
    // counts as running. ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

/**
 * Start the loop as a detached process, so it outlives the request that started
 * it. Clears the kill switch first, or the loop would stop at its first
 * transition; refuses if one is already running, so two do not fight over the
 * claims. cargo is put on PATH because the loop's Rust issues need it and a
 * server's environment usually does not carry it.
 */
export function startLoop(stateDir: string): number {
  if (runningPid(stateDir) !== null) throw new LoopAlreadyRunningError();

  const killSwitch = join(stateDir, 'stop');
  if (existsSync(killSwitch)) rmSync(killSwitch);

  const repoRoot = resolveRepoRoot(stateDir);
  const logFile = join(stateDir, 'loop.out.log');
  const out = openSync(logFile, 'a');

  const cargoBin = join(homedir(), '.cargo', 'bin');
  const child = spawn('pnpm', ['loop'], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PATH: `${cargoBin}:${process.env.PATH ?? ''}` },
  });
  child.unref();

  if (child.pid === undefined) {
    throw new Error('Failed to spawn the loop process.');
  }
  writeFileSync(pidFilePath(stateDir), String(child.pid));
  return child.pid;
}

/**
 * Stop the loop. The kill switch is the graceful path: the loop checks it
 * between transitions and exits after the current agents finish, leaving no
 * orphans. `force` also sends SIGTERM to the recorded pid for a prompt stop,
 * which is faster but abandons whatever an agent was doing.
 */
export function stopLoop(stateDir: string, force = false): void {
  writeFileSync(join(stateDir, 'stop'), '');
  if (!force) return;
  const pid = runningPid(stateDir);
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone between the read and the signal; the kill switch stands.
    }
  }
}

/**
 * Release one issue's claim so the loop can pick it again, for a run that went
 * stale. Only the local lockfile is removed; the GitHub `status:in-progress`
 * label is the loop's to manage, and is left untouched.
 */
export function releaseClaim(stateDir: string, issue: number): boolean {
  const file = join(stateDir, 'claims', `${issue}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
