/**
 * A cross-lane file mutex. Its one job is to serialise `pnpm verify --integration`:
 * the integration suites all talk to one Postgres, so two lanes running them at
 * once truncate each other's tables and the failure reads as data corruption
 * rather than the scheduling mistake it is.
 *
 * The lock is a directory, because `mkdir` is atomic on every filesystem the
 * loop runs on — a plain file check-then-write races. A lock older than its
 * lease is assumed abandoned by a crashed lane and reclaimed.
 */

import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export class FileMutex {
  private readonly lockDir: string;

  constructor(
    stateDir: string,
    name: string,
    private readonly leaseMs = 30 * 60 * 1000
  ) {
    this.lockDir = join(stateDir, `${name}.lock`);
  }

  private tryAcquire(): boolean {
    try {
      mkdirSync(this.lockDir);
      return true;
    } catch {
      // Reclaim a lock whose holder appears to have died mid-lease.
      try {
        const age = Date.now() - statSync(this.lockDir).mtimeMs;
        if (age > this.leaseMs) {
          rmSync(this.lockDir, { recursive: true, force: true });
          mkdirSync(this.lockDir);
          return true;
        }
      } catch {
        // Lost the race to another lane; fall through and keep waiting.
      }
      return false;
    }
  }

  /** Acquire, then run `fn`, then release even if `fn` throws. */
  async withLock<T>(fn: () => Promise<T>, pollMs = 2000): Promise<T> {
    while (!this.tryAcquire()) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
    try {
      return await fn();
    } finally {
      rmSync(this.lockDir, { recursive: true, force: true });
    }
  }
}
