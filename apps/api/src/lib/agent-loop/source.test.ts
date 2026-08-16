import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileLoopStateSource } from './source.js';

let stateDir: string;

function writeSnapshot(issue: number, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(stateDir, 'runs'), { recursive: true });
  writeFileSync(
    join(stateDir, 'runs', `${issue}.status.json`),
    JSON.stringify({
      issue,
      agent: 'claude-code',
      lane: 'A',
      branch: `agent/${issue}-x`,
      status: 'running',
      startedAt: '2026-08-16T10:00:00.000Z',
      endedAt: null,
      lastCursor: 0,
      prNumber: null,
      ...overrides,
    })
  );
}

function writeEvents(issue: number, lines: string[]): void {
  mkdirSync(join(stateDir, 'runs'), { recursive: true });
  writeFileSync(join(stateDir, 'runs', `${issue}.jsonl`), lines.join('\n') + '\n');
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agent-loop-src-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('FileLoopStateSource.board', () => {
  it('returns an empty board when nothing has run yet', () => {
    const board = new FileLoopStateSource(stateDir).board();
    expect(board.runs).toEqual([]);
    expect(board.status.running).toBe(false);
    expect(board.status.claims).toEqual([]);
  });

  it('enriches a run with the phase and message of its last event', () => {
    writeSnapshot(81, { lastCursor: 2 });
    writeEvents(81, [
      JSON.stringify({
        cursor: 1,
        at: '2026-08-16T10:00:01.000Z',
        level: 'info',
        phase: 'claim',
        message: 'claimed',
      }),
      JSON.stringify({
        cursor: 2,
        at: '2026-08-16T10:00:05.000Z',
        level: 'info',
        phase: 'verify',
        message: 'running pnpm verify',
      }),
    ]);

    const [run] = new FileLoopStateSource(stateDir).board().runs;
    expect(run.issue).toBe(81);
    expect(run.phase).toBe('verify');
    expect(run.lastMessage).toBe('running pnpm verify');
    expect(run.lastEventAt).toBe('2026-08-16T10:00:05.000Z');
  });

  it('sorts runs by most recent activity first', () => {
    writeSnapshot(10);
    writeEvents(10, [
      JSON.stringify({
        cursor: 1,
        at: '2026-08-16T09:00:00.000Z',
        level: 'info',
        phase: 'claim',
        message: 'a',
      }),
    ]);
    writeSnapshot(20);
    writeEvents(20, [
      JSON.stringify({
        cursor: 1,
        at: '2026-08-16T11:00:00.000Z',
        level: 'info',
        phase: 'claim',
        message: 'b',
      }),
    ]);

    const runs = new FileLoopStateSource(stateDir).board().runs;
    expect(runs.map((r) => r.issue)).toEqual([20, 10]);
  });

  it('skips a snapshot caught mid-write rather than failing the board', () => {
    writeSnapshot(1);
    mkdirSync(join(stateDir, 'runs'), { recursive: true });
    writeFileSync(join(stateDir, 'runs', '2.status.json'), '{ "issue": 2, ');

    const runs = new FileLoopStateSource(stateDir).board().runs;
    expect(runs.map((r) => r.issue)).toEqual([1]);
  });

  it('reports a claim as held from its lockfile', () => {
    mkdirSync(join(stateDir, 'claims'), { recursive: true });
    writeFileSync(join(stateDir, 'claims', '42.json'), '{}');
    writeFileSync(join(stateDir, 'claims', 'notes.txt'), 'ignore me');

    expect(new FileLoopStateSource(stateDir).board().status.claims).toEqual([42]);
  });

  it('reports the stop request when the kill switch is present', () => {
    writeFileSync(join(stateDir, 'stop'), '');
    expect(new FileLoopStateSource(stateDir).board().status.stopRequested).toBe(true);
  });

  it('treats a live recorded pid as running and a dead one as not', () => {
    writeFileSync(join(stateDir, 'loop.pid'), String(process.pid));
    expect(new FileLoopStateSource(stateDir).board().status.running).toBe(true);

    writeFileSync(join(stateDir, 'loop.pid'), '2147480000');
    expect(new FileLoopStateSource(stateDir).board().status.running).toBe(false);
  });
});

describe('FileLoopStateSource.events', () => {
  it('returns only events past the given cursor', () => {
    writeEvents(7, [
      JSON.stringify({ cursor: 1, at: 't1', level: 'info', phase: 'claim', message: 'one' }),
      JSON.stringify({ cursor: 2, at: 't2', level: 'info', phase: 'verify', message: 'two' }),
      JSON.stringify({ cursor: 3, at: 't3', level: 'warn', phase: 'repair', message: 'three' }),
    ]);

    const events = new FileLoopStateSource(stateDir).events(7, 1);
    expect(events.map((e) => e.cursor)).toEqual([2, 3]);
  });

  it('returns nothing for a run with no log', () => {
    expect(new FileLoopStateSource(stateDir).events(999)).toEqual([]);
  });

  it('ignores a corrupt line', () => {
    writeEvents(8, [
      JSON.stringify({ cursor: 1, at: 't1', level: 'info', phase: 'claim', message: 'ok' }),
      'not json',
    ]);
    expect(new FileLoopStateSource(stateDir).events(8).map((e) => e.cursor)).toEqual([1]);
  });
});
