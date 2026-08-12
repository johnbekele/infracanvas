import type { IrNode } from '@infracanvas/ir-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { threeTier } from '../../ir/fixtures';
import { registerBuiltInResources } from '../../resources';
import { resetResourceRegistry } from '../../resources/registry';
import { defaultAssumptions, withOverride } from '../assumptions';
import {
  DEFAULT_SERVICE_TIMES_MS,
  arrivalRateFrom,
  latencyContext,
  latencyContribution,
  pathLatency,
  sequentialPath,
  withArrivalRate,
  type LatencyContext,
  type PathSegment,
} from './index';
import { sojournPercentile } from './queue';

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

function nodeOf(kind: IrNode['kind']): IrNode {
  const node = threeTier().nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) throw new Error(`The three-tier fixture no longer contains a ${kind}.`);
  return node;
}

function at(arrivalRateRps: number): LatencyContext {
  return withArrivalRate(latencyContext(), arrivalRateRps);
}

const topic: IrNode = {
  id: 'sns-events',
  kind: 'sns_topic',
  name: 'Events',
  layout: { x: 0, y: 0 },
  params: {},
};

describe('one resource', () => {
  it('prefers a resource contract over the default table', () => {
    const modelled = latencyContribution(nodeOf('rds_instance'), at(10));

    // The RDS contract puts a single unqueued query at 2ms, and the table's
    // 8ms is the figure for a database nothing models.
    expect(modelled.value.serviceTimeMs).toBeCloseTo(2 / Math.LN2, 9);
    expect(modelled.value.serviceTimeMs).not.toBeCloseTo(8, 3);

    resetResourceRegistry();
    const tabled = latencyContribution(nodeOf('rds_instance'), at(10));
    expect(tabled.value.serviceTimeMs).toBe(DEFAULT_SERVICE_TIMES_MS.rds_instance);
  });

  it('returns a fixed contribution for a resource with no queue', () => {
    const flooded = latencyContribution(nodeOf('alb'), at(50_000));

    expect(flooded.value.model).toBe('fixed');
    expect(flooded.value.utilisation).toBe(0);
    expect(flooded.value.saturated).toBe(false);
    expect(flooded.value.queueMs).toBe(0);
    expect(flooded.value.totalMs).toBe(DEFAULT_SERVICE_TIMES_MS.alb);
    expect(flooded.gaps).toEqual([]);
  });

  it('queues at a service, with one server per task', () => {
    const contribution = latencyContribution(nodeOf('ecs_service'), at(30)).value;

    expect(contribution.model).toBe('m/m/c');
    expect(contribution.servers).toBe(2);
    expect(contribution.utilisation).toBeCloseTo(30 / (2 * (1000 / 40)), 12);
    expect(contribution.queueMs).toBeGreaterThan(0);
  });

  it('flags a saturated resource and says why it stopped computing', () => {
    const contribution = latencyContribution(nodeOf('ecs_service'), at(200));

    expect(contribution.value.saturated).toBe(true);
    expect(contribution.value.utilisation).toBeGreaterThan(1);
    expect(Number.isFinite(contribution.value.totalMs)).toBe(true);
    expect(contribution.gaps.join()).toContain('utilisation');
  });

  it('a service time supplied by the user replaces the default and is marked source user', () => {
    const assumptions = withOverride(
      defaultAssumptions(),
      'service.timeMs.rds_instance',
      12,
      'user'
    );
    const ctx = withArrivalRate(latencyContext(assumptions), 10);

    const contribution = latencyContribution(nodeOf('rds_instance'), ctx);

    expect(contribution.value.serviceTimeMs).toBe(12);
    const supplied = contribution.assumptions.find(
      (assumption) => assumption.id === 'service.timeMs.rds_instance'
    );
    expect(supplied?.source).toBe('user');
    expect(supplied?.value).toBe(12);
  });

  it('reports a kind nothing gives a service time rather than adding zero silently', () => {
    const contribution = latencyContribution(topic, at(10));

    expect(contribution.value.totalMs).toBe(0);
    expect(contribution.gaps.join()).toContain('sns_topic');
  });

  it('says nothing about a resource a request does not stop at', () => {
    const contribution = latencyContribution(nodeOf('vpc'), at(10));

    expect(contribution.value.totalMs).toBe(0);
    expect(contribution.gaps).toEqual([]);
  });

  it('applies the kingman correction only when a variability assumption is supplied', () => {
    const poisson = latencyContribution(nodeOf('ecs_service'), at(30));
    const bursty = latencyContribution(
      nodeOf('ecs_service'),
      withArrivalRate(
        latencyContext(withOverride(defaultAssumptions(), 'traffic.arrivalCv', 2)),
        30
      )
    );

    expect(poisson.value.assumptionIds).not.toContain('traffic.arrivalCv');
    expect(poisson.assumptions.map((assumption) => assumption.id)).not.toContain(
      'service.serviceCv'
    );

    expect(bursty.value.queueMs).toBeCloseTo(poisson.value.queueMs * 2.5, 9);
    expect(bursty.value.assumptionIds).toContain('traffic.arrivalCv');
    expect(bursty.value.assumptionIds).toContain('service.serviceCv');
  });

  it('leaves a resource with no queue untouched by a variability assumption', () => {
    const bursty = latencyContribution(
      nodeOf('alb'),
      withArrivalRate(
        latencyContext(withOverride(defaultAssumptions(), 'traffic.arrivalCv', 3)),
        30
      )
    );

    expect(bursty.value.totalMs).toBe(DEFAULT_SERVICE_TIMES_MS.alb);
    expect(bursty.value.assumptionIds).not.toContain('traffic.arrivalCv');
  });
});

describe('a request path', () => {
  const worker: IrNode = { ...nodeOf('ecs_service'), id: 'ecs-worker', name: 'Worker service' };
  const path = sequentialPath([
    nodeOf('alb'),
    nodeOf('ecs_service'),
    worker,
    nodeOf('rds_instance'),
  ]);

  it('path mean equals the sum of the resource means', () => {
    const predicted = pathLatency(path, at(30));

    const sum = predicted.value.contributions.reduce(
      (total, contribution) => total + contribution.totalMs,
      0
    );
    expect(Math.abs(predicted.value.meanMs - sum)).toBeLessThan(1e-9);
  });

  it('path p95 is below the sum of the resource p95 values', () => {
    const predicted = pathLatency(path, at(30));

    const queueing = predicted.value.contributions.filter(
      (contribution) => contribution.model !== 'fixed'
    );
    expect(queueing.length).toBeGreaterThan(1);

    const sum = predicted.value.contributions.reduce(
      (total, contribution) => total + sojournPercentile(contribution, 0.95),
      0
    );
    expect(predicted.value.p95Ms).toBeLessThan(sum);
    expect(predicted.value.p95Ms).toBeGreaterThan(predicted.value.meanMs);
  });

  it('orders its percentiles and reports every resource it passed through', () => {
    const predicted = pathLatency(path, at(30)).value;

    expect(predicted.path).toEqual(['alb-public', 'ecs-api', 'ecs-worker', 'rds-primary']);
    expect(predicted.p50Ms).toBeLessThan(predicted.p95Ms);
    expect(predicted.p95Ms).toBeLessThan(predicted.p99Ms);
    expect(predicted.p50Ms).toBeGreaterThan(0);
  });

  it('lists the saturated resources in path order and nothing else', () => {
    const predicted = pathLatency(path, at(60)).value;

    expect(predicted.saturatedAt).toEqual(['ecs-api', 'ecs-worker']);
  });

  it('reads the same percentiles off the grid as the closed form gives', () => {
    // A path of one resource has an answer that does not need the grid, which
    // is what makes it worth checking the grid against: the discretisation and
    // the collected tail have to be invisible at the percentiles reported.
    const single = pathLatency(sequentialPath([nodeOf('ecs_service')]), at(40));
    const contribution = single.value.contributions[0]!;

    for (const [quantile, reported] of [
      [0.5, single.value.p50Ms],
      [0.95, single.value.p95Ms],
      [0.99, single.value.p99Ms],
    ] as const) {
      const closedForm = sojournPercentile(contribution, quantile);
      expect(Math.abs(reported - closedForm) / closedForm).toBeLessThan(0.01);
    }
    expect(single.value.meanMs).toBeCloseTo(contribution.totalMs, 12);
  });

  it('grows with the load rather than staying still', () => {
    const quiet = pathLatency(path, at(5)).value;
    const busy = pathLatency(path, at(45)).value;

    expect(busy.meanMs).toBeGreaterThan(quiet.meanMs);
    expect(busy.p95Ms).toBeGreaterThan(quiet.p95Ms);
  });
});

describe('a parallel fan-out', () => {
  const branches: PathSegment[] = [
    { kind: 'fan-out', branches: [[nodeOf('ecs_service')], [nodeOf('rds_instance')]] },
  ];

  it('parallel fan-out takes the slower branch', () => {
    const fanOut = pathLatency(branches, at(30)).value;
    const slower = pathLatency(sequentialPath([nodeOf('ecs_service')]), at(30)).value;
    const faster = pathLatency(sequentialPath([nodeOf('rds_instance')]), at(30)).value;

    expect(faster.p95Ms).toBeLessThan(slower.p95Ms);
    // Waiting for both is worse than waiting for the slower one alone, because
    // either branch being slow is enough, and far better than visiting them in
    // turn.
    expect(fanOut.p95Ms).toBeGreaterThanOrEqual(slower.p95Ms * 0.99);
    expect(fanOut.p95Ms).toBeLessThan(slower.p95Ms + faster.p95Ms);
    expect(fanOut.meanMs).toBeLessThan(slower.meanMs + faster.meanMs);
  });

  it('keeps both branches in the contributions it reports', () => {
    const fanOut = pathLatency(branches, at(30)).value;

    expect(fanOut.path).toEqual(['ecs-api', 'rds-primary']);
    expect(fanOut.contributions).toHaveLength(2);
  });

  it('is slower than either branch alone once both can be slow', () => {
    const fanOut = pathLatency(branches, at(30)).value;
    const slower = pathLatency(sequentialPath([nodeOf('ecs_service')]), at(30)).value;

    expect(fanOut.meanMs).toBeGreaterThan(slower.meanMs);
  });
});

describe('the envelope', () => {
  it('labels every figure as predicted', () => {
    expect(latencyContribution(nodeOf('alb'), at(10)).label).toBe('Predicted');
    expect(pathLatency(sequentialPath([nodeOf('alb')]), at(10)).label).toBe('Predicted');
  });

  it('carries the assumptions the figure moved with', () => {
    const ctx = latencyContext();
    const predicted = pathLatency(sequentialPath([nodeOf('alb'), nodeOf('ecs_service')]), ctx);

    const ids = predicted.assumptions.map((assumption) => assumption.id);
    expect(ids).toContain('service.timeMs.alb');
    expect(ids).toContain('service.timeMs.ecs_service');
    expect(ids).toContain('traffic.requestsPerMonth');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('claims no assumption for a rate the caller chose', () => {
    const predicted = latencyContribution(nodeOf('ecs_service'), at(30));

    expect(predicted.assumptions.map((assumption) => assumption.id)).toEqual([
      'service.timeMs.ecs_service',
    ]);
  });

  it('derives the arrival rate from the traffic assumptions', () => {
    const assumptions = defaultAssumptions();

    expect(arrivalRateFrom(assumptions)).toBeCloseTo(2_000_000 / (730 * 3600), 12);
    expect(latencyContext(assumptions).arrivalRateRps).toBe(arrivalRateFrom(assumptions));
  });

  it('carries every resource gap on the path into the path prediction', () => {
    const predicted = pathLatency(sequentialPath([nodeOf('alb'), topic]), at(10));

    expect(predicted.gaps.join()).toContain('sns_topic');
  });
});

describe('the default service times', () => {
  it('is keyed by resource kind and agrees with the assumptions it came from', () => {
    const assumptions = defaultAssumptions();

    for (const [kind, value] of Object.entries(DEFAULT_SERVICE_TIMES_MS)) {
      expect(assumptions.get(`service.timeMs.${kind}`)?.value).toBe(value);
    }
    expect(Object.keys(DEFAULT_SERVICE_TIMES_MS).length).toBeGreaterThan(9);
  });
});

describe('performance', () => {
  it('predicts 20 paths across a 40 resource architecture inside the interactive budget', () => {
    const document = threeTier();
    const service = nodeOf('ecs_service');
    while (document.nodes.length < 40) {
      document.nodes.push({ ...service, id: `ecs-${document.nodes.length}`, parent: undefined });
    }
    const services = document.nodes.filter((node) => node.kind === 'ecs_service');
    const paths = services
      .slice(0, 20)
      .map((node) =>
        sequentialPath([nodeOf('alb'), node, nodeOf('rds_instance'), nodeOf('ecs_service')])
      );
    const ctx = at(30);

    for (let warmUp = 0; warmUp < 5; warmUp += 1) {
      for (const path of paths) pathLatency(path, ctx);
    }

    const samples: number[] = [];
    for (let sample = 0; sample < 100; sample += 1) {
      const started = performance.now();
      for (const path of paths) pathLatency(path, ctx);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    expect(paths).toHaveLength(20);
    // 2.85ms here. The ceiling is the point at which a canvas recompute stops
    // feeling instant, not the measured cost plus a little: CI runs every
    // package's suite at once on a small runner, where the IR validator was
    // measured twenty-six times slower with no change to its work, and a budget
    // that fails for that reason teaches everyone to rerun red checks.
    expect(samples[50]).toBeLessThan(100);
  });
});
