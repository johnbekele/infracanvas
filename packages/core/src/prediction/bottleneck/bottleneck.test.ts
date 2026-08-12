import type { IrNode } from '@infracanvas/ir-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { threeTier } from '../../ir/fixtures';
import { registerBuiltInResources } from '../../resources';
import { resetResourceRegistry } from '../../resources/registry';
import { AWS_LIMITS } from '../limits/aws-limits';
import type { BottleneckContext, ServiceLimit } from '../limits/types';
import {
  bottleneckContext,
  concurrency,
  findBottleneck,
  limitValueFor,
  residenceSeconds,
  RPS_CEILING,
  RPS_TOLERANCE,
  solveBreakingRps,
  withTargetRps,
} from './index';

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

function nodeOf(kind: IrNode['kind']): IrNode {
  const node = threeTier().nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) throw new Error(`The three-tier fixture no longer contains a ${kind}.`);
  return node;
}

function lambdaNode(params: Record<string, string | number | boolean> = {}): IrNode {
  return {
    id: 'lambda-api',
    kind: 'lambda_function',
    name: 'API function',
    layout: { x: 0, y: 0 },
    params: { runtime: 'nodejs20.x', memoryMb: 512, ...params },
  };
}

const cache: IrNode = {
  id: 'cache-sessions',
  kind: 'elasticache_cluster',
  name: 'Session cache',
  layout: { x: 0, y: 0 },
  params: { engine: 'valkey', nodeType: 'cache.t4g.micro' },
};

function limit(id: string): ServiceLimit {
  const found = AWS_LIMITS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`The limit table no longer carries ${id}.`);
  return found;
}

function at(targetRps: number): BottleneckContext {
  return withTargetRps(bottleneckContext(), targetRps);
}

describe("little's law", () => {
  it("computes required concurrency from little's law", () => {
    expect(concurrency(200, 0.05)).toBe(10);
    expect(concurrency(0, 12)).toBe(0);
    expect(concurrency(1000, 0.055)).toBeCloseTo(55, 12);
  });

  it('is what the connection and execution limits are counting', () => {
    const ctx = at(30);
    const lambda = lambdaNode();
    const rps = 500;

    const expected = concurrency(rps, residenceSeconds(lambda, rps, ctx));
    expect(limit('lambda.concurrentExecutions').usageAt(lambda, rps, ctx)).toBeCloseTo(
      expected,
      12
    );
  });
});

describe('solving one limit', () => {
  it('solves within tolerance against a closed-form limit', () => {
    // Serving capacity has an answer in closed form: the rate at which two
    // tasks of forty milliseconds each reach ninety-five per cent utilisation.
    const service = nodeOf('ecs_service');
    const closedForm = (0.95 * 2) / 0.04;

    const solved = solveBreakingRps(limit('queue.capacity'), service, at(30));

    expect(solved).not.toBeNull();
    expect(Math.abs((solved ?? 0) - closedForm)).toBeLessThanOrEqual(RPS_TOLERANCE);
  });

  it('finds the rate at which lambda concurrent executions are exhausted', () => {
    const ctx = at(30);
    const lambda = lambdaNode();
    const executions = limit('lambda.concurrentExecutions');

    const solved = solveBreakingRps(executions, lambda, ctx);

    expect(solved).not.toBeNull();
    const rate = solved ?? 0;
    expect(executions.usageAt(lambda, rate, ctx)).toBeGreaterThanOrEqual(executions.value);
    expect(executions.usageAt(lambda, rate - 2 * RPS_TOLERANCE, ctx)).toBeLessThan(
      executions.value
    );
    // Little's Law read the other way: the rate that fills a thousand
    // executions is a thousand divided by how long each one is in flight.
    expect(rate * residenceSeconds(lambda, rate, ctx)).toBeCloseTo(executions.value, 0);
  });

  it('finds the rate at which an rds instance runs out of connections', () => {
    const ctx = at(30);
    const database = nodeOf('rds_instance');
    const connections = limit('rds.maxConnections');

    // A db.t3.micro has a gibibyte of memory, and the default parameter gives
    // it a hundred and twelve connections rather than the five thousand a large
    // instance reaches.
    expect(limitValueFor(connections, database)).toBe(112);

    const solved = solveBreakingRps(connections, database, ctx);
    const rate = solved ?? 0;
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(RPS_CEILING);
    expect(connections.usageAt(database, rate, ctx)).toBeGreaterThanOrEqual(112);
    expect(connections.usageAt(database, rate - 2 * RPS_TOLERANCE, ctx)).toBeLessThan(112);
  });

  it('returns nothing for a limit no rate below the ceiling reaches', () => {
    // Sixty-five thousand connections to a cache serving under a millisecond is
    // not a rate this model will name, and inventing one would be worse than
    // saying so.
    expect(solveBreakingRps(limit('elasticache.clientConnections'), cache, at(30))).toBeNull();
  });

  it('reports a resource already over its limit as breaking at no load at all', () => {
    const alwaysOver: ServiceLimit = { ...limit('queue.capacity'), value: 0 };

    expect(solveBreakingRps(alwaysOver, nodeOf('ecs_service'), at(30))).toBe(0);
  });
});

describe('the report', () => {
  const architecture = [nodeOf('alb'), nodeOf('ecs_service'), nodeOf('rds_instance'), lambdaNode()];

  it('returns the component that breaks first', () => {
    const report = findBottleneck(architecture, at(30)).value;

    expect(report.first?.resourceId).toBe('ecs-api');
    expect(report.first?.limitId).toBe('queue.capacity');
    expect(report.first?.breakingRps).toBeCloseTo(47.5, 0);
    expect(report.first).toBe(report.ranked[0]);
  });

  it('ranks ascending by breaking rate with no duplicates', () => {
    const report = findBottleneck(architecture, at(30)).value;

    for (let index = 1; index < report.ranked.length; index += 1) {
      expect(report.ranked[index]!.breakingRps).toBeGreaterThanOrEqual(
        report.ranked[index - 1]!.breakingRps
      );
    }
    const keys = report.ranked.map((entry) => `${entry.resourceId}:${entry.limitId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('measures headroom and usage from the rate it was asked about', () => {
    const report = findBottleneck(architecture, at(30)).value;
    const first = report.first!;

    expect(report.targetRps).toBe(30);
    expect(first.headroomRps).toBeCloseTo(first.breakingRps - 30, 9);
    expect(first.usageAtTarget).toBeGreaterThan(0);
    expect(first.usageAtTarget).toBeLessThan(first.limitValue);
  });

  it('names the quota code and a raise-the-quota remedy for an adjustable limit', () => {
    const report = findBottleneck([lambdaNode()], at(30)).value;

    const executions = report.ranked.find(
      (entry) => entry.limitId === 'lambda.concurrentExecutions'
    );
    expect(executions?.adjustable).toBe(true);
    expect(executions?.remedy).toContain('L-B99A9384');
    expect(executions?.remedy).toMatch(/^Raise the quota/);
  });

  it('falls back to queueing capacity when no quota binds first', () => {
    const report = findBottleneck([cache], at(30)).value;

    expect(report.ranked.map((entry) => entry.limitId)).toEqual(['queue.capacity']);
    expect(report.first?.adjustable).toBe(false);
    expect(report.first?.remedy).toMatch(/Add servers or make cache-sessions faster/);
  });

  it('reports no bottleneck below the ceiling rather than inventing one', () => {
    const report = findBottleneck([nodeOf('vpc'), nodeOf('subnet'), nodeOf('alb')], at(30));

    expect(report.value.first).toBeNull();
    expect(report.value.ranked).toEqual([]);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toContain('100,000');
  });

  it('keeps a quota out of the report for a resource it does not cover', () => {
    const standard: IrNode = {
      id: 'sqs-jobs',
      kind: 'sqs_queue',
      name: 'Jobs',
      layout: { x: 0, y: 0 },
      params: {},
    };
    const fifo: IrNode = { ...standard, id: 'sqs-orders', params: { fifo: true } };

    expect(findBottleneck([standard], at(30)).value.ranked).toEqual([]);
    expect(findBottleneck([fifo], at(30)).value.ranked.map((entry) => entry.limitId)).toEqual([
      'sqs.fifoThroughput',
    ]);
  });

  it('breaks a fifo queue at the published three hundred messages a second', () => {
    const fifo: IrNode = {
      id: 'sqs-orders',
      kind: 'sqs_queue',
      name: 'Orders',
      layout: { x: 0, y: 0 },
      params: { fifo: true },
    };

    expect(findBottleneck([fifo], at(30)).value.first?.breakingRps).toBeCloseTo(300, 0);
  });

  it('returns the same report for the same architecture twice', () => {
    expect(findBottleneck(architecture, at(30))).toEqual(findBottleneck(architecture, at(30)));
  });
});

describe('the envelope', () => {
  it('labels the report as predicted and lists what the residence times rest on', () => {
    const report = findBottleneck([nodeOf('ecs_service'), nodeOf('rds_instance')], at(30));

    expect(report.label).toBe('Predicted');
    expect(report.assumptions.map((assumption) => assumption.id)).toContain(
      'service.timeMs.ecs_service'
    );
  });

  it('names the traffic assumptions when the target rate came from them', () => {
    const report = findBottleneck([nodeOf('ecs_service')], bottleneckContext());

    const ids = report.assumptions.map((assumption) => assumption.id);
    expect(ids).toContain('traffic.requestsPerMonth');
    expect(ids).toContain('time.hoursPerMonth');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('claims no traffic assumption for a rate the caller chose', () => {
    const report = findBottleneck([nodeOf('ecs_service')], at(30));

    expect(report.assumptions.map((assumption) => assumption.id)).not.toContain(
      'traffic.requestsPerMonth'
    );
  });
});

describe('performance', () => {
  it('solves a 40 resource architecture against the whole limit table inside the interactive budget', () => {
    const architecture: IrNode[] = [];
    const service = nodeOf('ecs_service');
    const database = nodeOf('rds_instance');
    while (architecture.length < 40) {
      const index = architecture.length;
      architecture.push(
        index % 4 === 0
          ? { ...service, id: `ecs-${index}` }
          : index % 4 === 1
            ? { ...database, id: `rds-${index}` }
            : index % 4 === 2
              ? { ...lambdaNode({ reservedConcurrency: 50 }), id: `lambda-${index}` }
              : { ...cache, id: `cache-${index}` }
      );
    }
    const ctx = at(30);

    for (let warmUp = 0; warmUp < 5; warmUp += 1) findBottleneck(architecture, ctx);

    const samples: number[] = [];
    for (let sample = 0; sample < 100; sample += 1) {
      const started = performance.now();
      findBottleneck(architecture, ctx);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    expect(architecture).toHaveLength(40);
    // 0.87ms here, against a ceiling set where a canvas recompute stops feeling
    // instant. See the note on the latency budget: CI measures a contended
    // runner as much as the code, so a tight ceiling fails for reasons the
    // author cannot fix.
    expect(samples[50]).toBeLessThan(100);
  });
});
