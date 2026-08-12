import { describe, expect, it } from 'vitest';
import { applyFrame, applyOutcome, parseFrame, QUEUED, type ProgressFrame } from './progress';

function frame(overrides: Partial<ProgressFrame> = {}): ProgressFrame {
  return {
    at: '2026-08-12T20:00:00.000Z',
    level: 'info',
    message: 'Read 12 of 40 files.',
    progress: 0.4,
    ...overrides,
  };
}

describe('applyFrame', () => {
  it('takes the fraction and message the worker reported', () => {
    const next = applyFrame(QUEUED, frame());

    expect(next.fraction).toBeCloseTo(0.4);
    expect(next.message).toBe('Read 12 of 40 files.');
    expect(next.status).toBe('streaming');
  });

  it('keeps the bar where it was for a line that reports no advance', () => {
    // A retry warning carries no fraction. Letting it reset the bar would read
    // as the run starting over, which is the opposite of what happened.
    const current = applyFrame(QUEUED, frame({ progress: 0.6 }));

    const next = applyFrame(
      current,
      frame({ progress: null, level: 'warn', message: 'Retrying.' })
    );

    expect(next.fraction).toBeCloseTo(0.6);
    expect(next.level).toBe('warn');
  });
});

describe('applyOutcome', () => {
  it('shows a finished run as complete even if the last frame was short of the end', () => {
    const current = applyFrame(QUEUED, frame({ progress: 0.95 }));

    expect(applyOutcome(current, 'succeeded').fraction).toBe(1);
  });

  it('reports the failure rather than the last thing that went right', () => {
    const current = applyFrame(QUEUED, frame({ message: 'Read 40 of 40 files.' }));

    const next = applyOutcome(current, 'failed', 'GitHub returned 404 while fetching the tree');

    expect(next.status).toBe('failed');
    expect(next.level).toBe('error');
    expect(next.message).toBe('GitHub returned 404 while fetching the tree');
    // The bar stays where it stopped: a failed run did not reach the end, and
    // showing 100% would say it did.
    expect(next.fraction).toBeCloseTo(0.4);
  });
});

describe('parseFrame', () => {
  it('reads a frame', () => {
    expect(parseFrame<{ message: string }>('{"message":"hello"}')).toEqual({ message: 'hello' });
  });

  it('treats anything malformed as no frame at all', () => {
    // A half-delivered frame should leave the bar alone rather than throw inside
    // an event listener, where nothing would catch it.
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame(undefined)).toBeNull();
  });
});
