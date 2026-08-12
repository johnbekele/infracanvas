import { describe, expect, it } from 'vitest';

import {
  erlangC,
  kingmanFactor,
  SATURATION_THRESHOLD,
  sojournPercentile,
  sojournSurvival,
  solveQueue,
  type QueueInput,
} from './queue';

function queue(overrides: Partial<QueueInput> = {}): QueueInput {
  return {
    resourceId: 'resource',
    model: 'm/m/c',
    servers: 1,
    serviceTimeMs: 10,
    arrivalRateRps: 40,
    arrivalCv: 1,
    serviceCv: 1,
    assumptionIds: [],
    ...overrides,
  };
}

/** Wq for M/M/1, in milliseconds, from the closed form rather than from this module. */
function closedFormWaitMs(serviceTimeMs: number, arrivalRateRps: number): number {
  const serviceRate = 1000 / serviceTimeMs;
  const utilisation = arrivalRateRps / serviceRate;
  return (utilisation / (serviceRate - arrivalRateRps)) * 1000;
}

describe('erlang c', () => {
  it('matches published erlang c values', () => {
    // The offered loads are 0.5, 1, 3 and 15 Erlangs, which are the rows an
    // Erlang C table is usually printed with. The figures below are the
    // textbook expression evaluated in exact rational arithmetic, because a
    // published table stops at four decimal places and the acceptance
    // criterion asks for six.
    expect(erlangC(1, 0.5)).toBeCloseTo(0.5, 6);
    expect(erlangC(2, 0.5)).toBeCloseTo(0.333333333333, 6);
    expect(erlangC(5, 0.6)).toBeCloseTo(0.236151603499, 6);
    expect(erlangC(20, 0.75)).toBeCloseTo(0.160429387417, 6);
  });

  it('equals the utilisation when there is one server', () => {
    for (const utilisation of [0.1, 0.25, 0.5, 0.75, 0.99]) {
      expect(erlangC(1, utilisation)).toBeCloseTo(utilisation, 12);
    }
  });

  it('stays finite past the server count a factorial can hold', () => {
    // 171! overflows a double, so the textbook expression returns NaN here and
    // the recursion this is built on does not.
    for (const servers of [200, 1000, 20_000]) {
      const waiting = erlangC(servers, 0.9);
      expect(Number.isFinite(waiting)).toBe(true);
      expect(waiting).toBeGreaterThan(0);
      expect(waiting).toBeLessThan(1);
    }
  });

  it('falls as servers are added at the same utilisation', () => {
    const ladder = [1, 2, 5, 10, 40].map((servers) => erlangC(servers, 0.8));
    for (let index = 1; index < ladder.length; index += 1) {
      expect(ladder[index]).toBeLessThan(ladder[index - 1] ?? 1);
    }
  });

  it('is nothing at no load and certain at full load', () => {
    expect(erlangC(4, 0)).toBe(0);
    expect(erlangC(4, -1)).toBe(0);
    expect(erlangC(4, 1)).toBe(1);
    expect(erlangC(4, 2)).toBe(1);
  });
});

describe('the single server case', () => {
  it('reduces to the m/m/1 waiting time with a single server', () => {
    for (const arrivalRateRps of [1, 10, 40, 80, 94]) {
      const solved = solveQueue(queue({ servers: 1, serviceTimeMs: 10, arrivalRateRps }));

      expect(solved.model).toBe('m/m/1');
      expect(Math.abs(solved.queueMs - closedFormWaitMs(10, arrivalRateRps))).toBeLessThan(1e-9);
      expect(solved.totalMs).toBeCloseTo(solved.queueMs + 10, 12);
    }
  });

  it('inverts the sojourn distribution to the m/m/1 closed form', () => {
    const solved = solveQueue(queue({ servers: 1, serviceTimeMs: 10, arrivalRateRps: 40 }));
    const drainRate = 1000 / 10 - 40;

    for (const quantile of [0.5, 0.95, 0.99]) {
      const closedForm = (Math.log(1 / (1 - quantile)) / drainRate) * 1000;
      expect(sojournPercentile(solved, quantile)).toBeCloseTo(closedForm, 6);
    }
  });

  it('has a sojourn distribution that starts at one and falls to nothing', () => {
    const solved = solveQueue(queue({ arrivalRateRps: 60 }));

    expect(sojournSurvival(solved, 0)).toBe(1);
    expect(sojournSurvival(solved, 1)).toBeLessThan(1);
    expect(sojournSurvival(solved, 100_000)).toBeCloseTo(0, 9);
  });
});

describe('several servers', () => {
  it('serves the same load faster than one server of the same speed', () => {
    const one = solveQueue(queue({ servers: 1, arrivalRateRps: 80 }));
    const four = solveQueue(queue({ servers: 4, arrivalRateRps: 80 }));

    expect(four.model).toBe('m/m/c');
    expect(four.utilisation).toBeCloseTo(one.utilisation / 4, 12);
    expect(four.queueMs).toBeLessThan(one.queueMs);
  });

  it('agrees with erlang c on the waiting time it reports', () => {
    const solved = solveQueue(queue({ servers: 6, serviceTimeMs: 20, arrivalRateRps: 200 }));
    const capacity = (6 * 1000) / 20;

    const expected = (erlangC(6, solved.utilisation) / (capacity - 200)) * 1000;
    expect(solved.queueMs).toBeCloseTo(expected, 9);
  });

  it('rounds a fractional server count rather than modelling half a server', () => {
    expect(solveQueue(queue({ servers: 2.4 })).servers).toBe(2);
    expect(solveQueue(queue({ servers: 0 })).servers).toBe(1);
  });
});

describe('saturation', () => {
  it('flags saturation instead of returning an unbounded queue', () => {
    const overloaded = solveQueue(queue({ servers: 1, serviceTimeMs: 10, arrivalRateRps: 400 }));
    const boundary = solveQueue(queue({ servers: 1, serviceTimeMs: 10, arrivalRateRps: 95 }));

    expect(overloaded.saturated).toBe(true);
    // The utilisation is reported as it is, because a resource taking four
    // times the traffic it can serve is the finding; only the queue is clamped.
    expect(overloaded.utilisation).toBeCloseTo(4, 12);
    expect(Number.isFinite(overloaded.queueMs)).toBe(true);
    expect(overloaded.queueMs).toBeCloseTo(boundary.queueMs, 9);
  });

  it('clamps at the threshold and not before it', () => {
    const under = solveQueue(queue({ arrivalRateRps: 94 }));
    const at = solveQueue(queue({ arrivalRateRps: 100 * SATURATION_THRESHOLD }));

    expect(under.saturated).toBe(false);
    expect(at.saturated).toBe(true);
    expect(at.queueMs).toBeGreaterThan(under.queueMs);
  });

  it('queueing grows superlinearly with the arrival rate', () => {
    const base = solveQueue(queue({ serviceTimeMs: 10, arrivalRateRps: 60 }));
    const doubled = solveQueue(queue({ serviceTimeMs: 10, arrivalRateRps: 120 }));

    expect(base.utilisation).toBeGreaterThan(0.5);
    expect(doubled.queueMs).toBeGreaterThan(2 * base.queueMs);

    // And below the clamp, where the growth is the model's rather than the
    // threshold's.
    const half = solveQueue(queue({ serviceTimeMs: 10, arrivalRateRps: 55 }));
    const whole = solveQueue(queue({ serviceTimeMs: 10, arrivalRateRps: 90 }));
    expect(whole.queueMs).toBeGreaterThan((2 * 90 * half.queueMs) / 110);
  });
});

describe('the kingman correction', () => {
  it('is exactly one for a poisson arrival stream and exponential service', () => {
    expect(kingmanFactor(1, 1)).toBe(1);
  });

  it('scales the queue and leaves the service time alone', () => {
    const poisson = solveQueue(queue({ arrivalRateRps: 60 }));
    const bursty = solveQueue(queue({ arrivalRateRps: 60, arrivalCv: 2, serviceCv: 1 }));

    expect(bursty.queueMs).toBeCloseTo(poisson.queueMs * 2.5, 9);
    expect(bursty.serviceTimeMs).toBe(poisson.serviceTimeMs);
    expect(bursty.utilisation).toBeCloseTo(poisson.utilisation, 12);
  });

  it('carries the correction into the percentiles rather than only the mean', () => {
    const poisson = solveQueue(queue({ arrivalRateRps: 60 }));
    const bursty = solveQueue(queue({ arrivalRateRps: 60, arrivalCv: 2 }));

    expect(sojournPercentile(bursty, 0.95)).toBeGreaterThan(sojournPercentile(poisson, 0.95));
  });
});

describe('a resource with no queue', () => {
  it('reports its service time and no utilisation', () => {
    const fixed = solveQueue(queue({ model: 'fixed', arrivalRateRps: 10_000 }));

    expect(fixed.model).toBe('fixed');
    expect(fixed.utilisation).toBe(0);
    expect(fixed.saturated).toBe(false);
    expect(fixed.queueMs).toBe(0);
    expect(fixed.totalMs).toBe(10);
  });

  it('has a sojourn time that is the service time exactly', () => {
    const fixed = solveQueue(queue({ model: 'fixed' }));

    expect(sojournPercentile(fixed, 0.5)).toBe(10);
    expect(sojournPercentile(fixed, 0.99)).toBe(10);
    expect(sojournSurvival(fixed, 9.99)).toBe(1);
    expect(sojournSurvival(fixed, 10)).toBe(0);
  });

  it('treats a resource with no service time as contributing nothing', () => {
    const nothing = solveQueue(queue({ serviceTimeMs: 0 }));

    expect(nothing.model).toBe('fixed');
    expect(nothing.totalMs).toBe(0);
    expect(nothing.utilisation).toBe(0);
  });
});

describe('percentiles', () => {
  it('rise with the quantile and sit above the service time', () => {
    const solved = solveQueue(queue({ servers: 3, arrivalRateRps: 200 }));

    const p50 = sojournPercentile(solved, 0.5);
    const p95 = sojournPercentile(solved, 0.95);
    const p99 = sojournPercentile(solved, 0.99);
    expect(p50).toBeLessThan(p95);
    expect(p95).toBeLessThan(p99);
    expect(p99).toBeGreaterThan(solved.serviceTimeMs);
  });

  it('returns nothing for a quantile of zero and infinity for one', () => {
    const solved = solveQueue(queue());

    expect(sojournPercentile(solved, 0)).toBe(0);
    expect(sojournPercentile(solved, 1)).toBe(Number.POSITIVE_INFINITY);
  });
});
