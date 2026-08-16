import { describe, expect, it } from 'vitest';

import { agentName, duration, laneAgent, phaseLabel, relativeTime } from './format';

describe('laneAgent', () => {
  it('maps each lane to its agent', () => {
    expect(laneAgent('A')).toBe('Claude Code');
    expect(laneAgent('B')).toBe('Codex');
    expect(laneAgent('C')).toBe('Cursor');
  });
});

describe('agentName', () => {
  it('gives the recorded kind a display name', () => {
    expect(agentName('claude-code')).toBe('Claude Code');
    expect(agentName('codex')).toBe('Codex');
    expect(agentName('cursor')).toBe('Cursor');
  });

  it('passes an unknown kind through unchanged', () => {
    expect(agentName('some-other')).toBe('some-other');
  });
});

describe('phaseLabel', () => {
  it('capitalises a phase word', () => {
    expect(phaseLabel('verify')).toBe('Verify');
  });

  it('shows a dash when there is no phase yet', () => {
    expect(phaseLabel(null)).toBe('—');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');

  it('reads seconds, minutes, hours, and days', () => {
    expect(relativeTime('2026-08-16T11:59:30.000Z', now)).toBe('30s ago');
    expect(relativeTime('2026-08-16T11:55:00.000Z', now)).toBe('5m ago');
    expect(relativeTime('2026-08-16T09:00:00.000Z', now)).toBe('3h ago');
    expect(relativeTime('2026-08-14T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('is empty for a missing or unparseable time', () => {
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('not a date', now)).toBe('');
  });
});

describe('duration', () => {
  const now = Date.parse('2026-08-16T12:30:00.000Z');

  it('measures to now for a run still going', () => {
    expect(duration('2026-08-16T12:00:00.000Z', null, now)).toBe('30m');
  });

  it('measures to the end for a finished run', () => {
    expect(duration('2026-08-16T10:00:00.000Z', '2026-08-16T11:05:00.000Z', now)).toBe('1h 5m');
  });

  it('reads seconds under a minute', () => {
    expect(duration('2026-08-16T12:29:15.000Z', null, now)).toBe('45s');
  });
});
