/**
 * The dashboard's read side, backed by the loop's own files:
 *
 *   <stateDir>/runs/<issue>.status.json   one RunSnapshot per run
 *   <stateDir>/runs/<issue>.jsonl         that run's append-only event log
 *   <stateDir>/claims/<issue>.json        an active claim
 *   <stateDir>/stop                       the kill switch
 *   <stateDir>/loop.pid                   the pid the API last spawned
 *
 * Reads tolerate a half-written file: the loop writes these continuously, and a
 * snapshot caught mid-write should drop that one run, not fail the whole board.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Lane, LoopBoard, LoopEvent, LoopRun, LoopStateSource, RunStatus } from './types.js';

interface RawSnapshot {
  issue: number;
  agent: string;
  lane: Lane;
  branch: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  lastCursor: number;
  prNumber: number | null;
}

/** True when a process with this pid exists and we may signal it. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: gone. EPERM: alive but owned by another user, which still counts as
    // running for the purpose of the header.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FileLoopStateSource implements LoopStateSource {
  private readonly runsDir: string;
  private readonly claimsDir: string;
  private readonly killSwitch: string;
  private readonly pidFile: string;

  constructor(private readonly stateDir: string) {
    this.runsDir = join(stateDir, 'runs');
    this.claimsDir = join(stateDir, 'claims');
    this.killSwitch = join(stateDir, 'stop');
    this.pidFile = join(stateDir, 'loop.pid');
  }

  board(): LoopBoard {
    const runs = this.readRuns();
    // Newest activity first, so the lanes doing something now sit at the top and
    // long-finished runs fall below. Undated runs sort last.
    runs.sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''));

    return {
      status: {
        running: this.loopRunning(),
        pid: this.readPid(),
        stopRequested: existsSync(this.killSwitch),
        claims: this.readClaims(),
        stateDir: this.stateDir,
      },
      runs,
    };
  }

  events(issue: number, afterCursor = 0): LoopEvent[] {
    const file = join(this.runsDir, `${issue}.jsonl`);
    if (!existsSync(file)) return [];
    const events: LoopEvent[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as LoopEvent;
        if (event.cursor > afterCursor) events.push(event);
      } catch {
        continue;
      }
    }
    return events;
  }

  private readRuns(): LoopRun[] {
    if (!existsSync(this.runsDir)) return [];
    const runs: LoopRun[] = [];
    for (const name of readdirSync(this.runsDir)) {
      if (!name.endsWith('.status.json')) continue;
      let snap: RawSnapshot;
      try {
        snap = JSON.parse(readFileSync(join(this.runsDir, name), 'utf8')) as RawSnapshot;
      } catch {
        continue;
      }
      const last = this.lastEvent(snap.issue);
      runs.push({
        issue: snap.issue,
        agent: snap.agent,
        lane: snap.lane,
        branch: snap.branch,
        status: snap.status,
        startedAt: snap.startedAt,
        endedAt: snap.endedAt,
        prNumber: snap.prNumber,
        lastCursor: snap.lastCursor,
        phase: last?.phase ?? null,
        lastMessage: last?.message ?? null,
        lastEventAt: last?.at ?? snap.startedAt,
      });
    }
    return runs;
  }

  /** The final event of a run, for the "what is it doing now" line on a card. */
  private lastEvent(issue: number): LoopEvent | null {
    const file = join(this.runsDir, `${issue}.jsonl`);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        return JSON.parse(line) as LoopEvent;
      } catch {
        continue;
      }
    }
    return null;
  }

  private readClaims(): number[] {
    if (!existsSync(this.claimsDir)) return [];
    const claims: number[] = [];
    for (const name of readdirSync(this.claimsDir)) {
      const match = /^(\d+)\.json$/.exec(name);
      if (match) claims.push(Number(match[1]));
    }
    return claims.sort((a, b) => a - b);
  }

  private readPid(): number | null {
    if (!existsSync(this.pidFile)) return null;
    const pid = Number(readFileSync(this.pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  private loopRunning(): boolean {
    const pid = this.readPid();
    return pid !== null && pidAlive(pid);
  }
}
