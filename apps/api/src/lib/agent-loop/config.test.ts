import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isEnabled, resolveRepoRoot, resolveStateDir } from './config.js';

const original = { ...process.env };

beforeEach(() => {
  delete process.env.AGENT_LOOP_DIR;
  delete process.env.AGENT_LOOP_ENABLED;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env = { ...original };
});

describe('resolveStateDir', () => {
  it('honours an explicit AGENT_LOOP_DIR', () => {
    process.env.AGENT_LOOP_DIR = '/tmp/somewhere/.agent-loop';
    expect(resolveStateDir()).toBe('/tmp/somewhere/.agent-loop');
  });
});

describe('resolveRepoRoot', () => {
  it('is the parent of the state directory', () => {
    expect(resolveRepoRoot('/repo/.agent-loop')).toBe('/repo');
  });
});

describe('isEnabled', () => {
  it('is forced on by AGENT_LOOP_ENABLED=1', () => {
    process.env.AGENT_LOOP_ENABLED = '1';
    process.env.NODE_ENV = 'production';
    expect(isEnabled()).toBe(true);
  });

  it('is forced off by AGENT_LOOP_ENABLED=0', () => {
    process.env.AGENT_LOOP_ENABLED = '0';
    process.env.NODE_ENV = 'development';
    expect(isEnabled()).toBe(false);
  });

  it('defaults on outside production and off in production', () => {
    process.env.NODE_ENV = 'development';
    expect(isEnabled()).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(isEnabled()).toBe(false);
  });
});
