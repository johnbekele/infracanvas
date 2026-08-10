import { describe, expect, it, vi, afterEach } from 'vitest';
import { logError, sanitiseForLog } from './log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sanitiseForLog', () => {
  it('keeps a forged log record on the line it was written to', () => {
    const line = sanitiseForLog('boom\nERROR admin login succeeded');

    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('boom\\nERROR admin login succeeded');
  });

  // JSON escapes \r but emits U+2028 and U+2029 raw, so those are stripped.
  it('leaves no raw line separator of any kind', () => {
    const line = sanitiseForLog('a\rb\u2028c\u2029d');

    expect(line).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(line).toBe('"a\\rbcd"');
  });

  it('preserves an error stack as escaped text rather than dropping it', () => {
    const line = sanitiseForLog(new Error('upstream said no'));

    expect(line).toContain('"name":"Error"');
    expect(line).toContain('"message":"upstream said no"');
    expect(line).toContain('"stack":"Error: upstream said no\\n');
    expect(line).not.toMatch(/[\r\n]/);
  });

  it('escapes a line break carried inside an error message', () => {
    const line = sanitiseForLog(new Error('boom\nERROR forged'));

    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('boom\\nERROR forged');
  });

  it('describes a value that is neither a string nor an error', () => {
    expect(sanitiseForLog({ code: 42 })).toBe('{"code":42}');
    expect(sanitiseForLog(undefined)).toBe('undefined');
  });

  it('falls back to String for a value JSON cannot encode', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(sanitiseForLog(circular)).toBe('[object Object]');
  });

  it('strips a line break the fallback path cannot escape', () => {
    const unencodable = {
      self: null as unknown,
      toString: () => 'boom\nERROR forged',
    };
    unencodable.self = unencodable;

    expect(sanitiseForLog(unencodable)).toBe('boomERROR forged');
  });

  it('truncates so one entry cannot flood the log', () => {
    expect(sanitiseForLog('x'.repeat(10_000))).toHaveLength(4096);
  });
});

describe('logError', () => {
  it('writes the fixed context and the flattened value as one line', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logError('Error pushing files', 'boom\ninjected');

    expect(spy).toHaveBeenCalledWith('Error pushing files: "boom\\ninjected"');
  });
});
