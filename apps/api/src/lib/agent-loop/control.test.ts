import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LoopAlreadyRunningError, releaseClaim, startLoop, stopLoop } from './control.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agent-loop-ctl-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('stopLoop', () => {
  it('writes the kill switch so the loop stops at the next transition', () => {
    stopLoop(stateDir);
    expect(existsSync(join(stateDir, 'stop'))).toBe(true);
  });
});

describe('releaseClaim', () => {
  it('removes an existing claim and reports it', () => {
    mkdirSync(join(stateDir, 'claims'), { recursive: true });
    writeFileSync(join(stateDir, 'claims', '81.json'), '{}');

    expect(releaseClaim(stateDir, 81)).toBe(true);
    expect(existsSync(join(stateDir, 'claims', '81.json'))).toBe(false);
  });

  it('reports false when no claim is held', () => {
    expect(releaseClaim(stateDir, 404)).toBe(false);
  });
});

describe('startLoop', () => {
  it('refuses when a live loop is already recorded', () => {
    // The current test process is certainly alive, so recording its pid makes the
    // guard fire without spawning anything.
    writeFileSync(join(stateDir, 'loop.pid'), String(process.pid));
    expect(() => startLoop(stateDir)).toThrow(LoopAlreadyRunningError);
  });
});
