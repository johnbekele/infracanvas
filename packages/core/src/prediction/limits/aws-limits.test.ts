import type { IrNode } from '@infracanvas/ir-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { threeTier } from '../../ir/fixtures';
import { registerBuiltInResources } from '../../resources';
import { resetResourceRegistry } from '../../resources/registry';
import {
  bottleneckContext,
  limitApplies,
  limitValueFor,
  RPS_CEILING,
  withTargetRps,
} from '../bottleneck';
import { SATURATION_THRESHOLD } from '../latency';
import { AWS_LIMITS, limitsFor } from './aws-limits';
import { ANY_SERVICE } from './types';

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

function nodeOf(kind: IrNode['kind']): IrNode {
  const node = threeTier().nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) throw new Error(`The three-tier fixture no longer contains a ${kind}.`);
  return node;
}

function rdsWith(instanceClass: string, engine: 'postgres' | 'mysql' | 'mariadb'): IrNode {
  const database = nodeOf('rds_instance');
  if (database.kind !== 'rds_instance') throw new Error('The fixture database changed kind.');
  return { ...database, params: { ...database.params, instanceClass, engine } };
}

/**
 * One resource per limit, so `usageAt` is sampled on something the limit
 * actually applies to rather than on a resource where it is constantly zero.
 */
const SUBJECTS: Readonly<Record<string, IrNode>> = {
  lambda: {
    id: 'lambda-api',
    kind: 'lambda_function',
    name: 'API function',
    layout: { x: 0, y: 0 },
    params: { runtime: 'nodejs20.x' },
  },
  rds: nodeOf('rds_instance'),
  elasticache: {
    id: 'cache-sessions',
    kind: 'elasticache_cluster',
    name: 'Session cache',
    layout: { x: 0, y: 0 },
    params: { engine: 'valkey', nodeType: 'cache.t4g.micro' },
  },
  sqs: {
    id: 'sqs-orders',
    kind: 'sqs_queue',
    name: 'Orders',
    layout: { x: 0, y: 0 },
    params: { fifo: true },
  },
  dynamodb: {
    id: 'ddb-sessions',
    kind: 'dynamodb_table',
    name: 'Sessions',
    layout: { x: 0, y: 0 },
    params: { billingMode: 'PAY_PER_REQUEST' },
  },
  [ANY_SERVICE]: nodeOf('ecs_service'),
};

describe('the limit table', () => {
  it('every limit is non-decreasing in request rate', () => {
    const ctx = withTargetRps(bottleneckContext(), 30);

    for (const limit of AWS_LIMITS) {
      const subject = SUBJECTS[limit.serviceId];
      expect(subject, `no subject resource for ${limit.id}`).toBeDefined();
      if (subject === undefined) continue;

      let previous = -Infinity;
      for (let step = 0; step <= 100; step += 1) {
        const rps = (RPS_CEILING * step) / 100;
        const usage = limit.usageAt(subject, rps, ctx);
        expect(Number.isFinite(usage), `${limit.id} at ${rps} rps`).toBe(true);
        expect(
          usage,
          `${limit.id} fell between ${rps} and the rate below it`
        ).toBeGreaterThanOrEqual(previous);
        previous = usage;
      }
    }
  });

  it('every entry carries a source and the date it was read', () => {
    for (const limit of AWS_LIMITS) {
      expect(limit.source.length, limit.id).toBeGreaterThan(0);
      expect(limit.retrievedAt, limit.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(limit.value, limit.id).toBeGreaterThan(0);
      expect(limit.unit.length, limit.id).toBeGreaterThan(0);
    }
  });

  it('cites an aws documentation page for every published quota', () => {
    for (const limit of AWS_LIMITS.filter((entry) => entry.serviceId !== ANY_SERVICE)) {
      expect(limit.source, limit.id).toMatch(/^https:\/\/docs\.aws\.amazon\.com\//);
    }
  });

  it('gives an adjustable limit the quota code that raises it', () => {
    for (const limit of AWS_LIMITS.filter((entry) => entry.adjustable)) {
      expect(limit.quotaCode, limit.id).toMatch(/^L-[0-9A-Z]+$/);
    }
  });

  it('identifies every limit uniquely', () => {
    const ids = AWS_LIMITS.map((limit) => limit.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the latency model saturation threshold for serving capacity', () => {
    const capacity = AWS_LIMITS.find((limit) => limit.id === 'queue.capacity');

    expect(capacity?.value).toBe(SATURATION_THRESHOLD);
    expect(capacity?.adjustable).toBe(false);
  });
});

describe('which limits reach which resource', () => {
  it('gives a database its connection limit and its serving capacity', () => {
    expect(limitsFor(nodeOf('rds_instance')).map((limit) => limit.id)).toEqual([
      'rds.maxConnections',
      'queue.capacity',
    ]);
  });

  it('gives a resource with no quota of its own only its serving capacity', () => {
    expect(limitsFor(nodeOf('ecs_service')).map((limit) => limit.id)).toEqual(['queue.capacity']);
  });

  it('excludes the fifo throughput limit from a standard queue', () => {
    const fifo = SUBJECTS.sqs!;
    const standard: IrNode = {
      id: 'sqs-jobs',
      kind: 'sqs_queue',
      name: 'Jobs',
      layout: { x: 0, y: 0 },
      params: {},
    };
    const throughput = AWS_LIMITS.find((limit) => limit.id === 'sqs.fifoThroughput')!;

    expect(limitApplies(throughput, fifo)).toBe(true);
    expect(limitApplies(throughput, standard)).toBe(false);
  });
});

describe('the rds connection ceiling', () => {
  it('reads the instance memory out of the instance class', () => {
    // LEAST({DBInstanceClassMemory/9531392}, 5000) for Postgres, where a
    // db.t3.micro has one gibibyte and a db.m5.large has eight.
    expect(limitValueFor(connections(), rdsWith('db.t3.micro', 'postgres'))).toBe(112);
    expect(limitValueFor(connections(), rdsWith('db.m5.large', 'postgres'))).toBe(901);
    expect(limitValueFor(connections(), rdsWith('db.r6g.xlarge', 'postgres'))).toBe(3604);
  });

  it('uses the engine divisor rather than one figure for all of them', () => {
    expect(limitValueFor(connections(), rdsWith('db.t3.micro', 'mysql'))).toBe(85);
    expect(limitValueFor(connections(), rdsWith('db.t3.micro', 'mariadb'))).toBe(85);
  });

  it('stops at the ceiling the default parameter imposes', () => {
    expect(limitValueFor(connections(), rdsWith('db.r5.2xlarge', 'postgres'))).toBe(5000);
  });

  it('falls back to the ceiling for an instance class it does not recognise', () => {
    expect(limitValueFor(connections(), rdsWith('db.z9.enormous', 'postgres'))).toBe(5000);
  });

  function connections() {
    const limit = AWS_LIMITS.find((entry) => entry.id === 'rds.maxConnections');
    if (limit === undefined)
      throw new Error('The limit table no longer carries rds.maxConnections');
    return limit;
  }
});
