import type { ArchitectureIr, IrEdge, IrNode } from '@infracanvas/ir-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { fourLevelChain, threeTier } from '../../ir/fixtures';
import { registerBuiltInResources } from '../../resources';
import { getResourceContract, resetResourceRegistry } from '../../resources/registry';
import { defaultAssumptions, withOverride } from '../assumptions';
import {
  availability,
  availabilityContext,
  MINUTES_PER_MONTH,
  parallelAvailability,
  seriesAvailability,
  type AvailabilityContext,
} from './index';
import { AWS_SLAS, findSla } from './slas';
import { proposeSlos } from './slo';

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

function contextWithCorrelation(correlation: number): AvailabilityContext {
  return {
    region: 'eu-west-1',
    assumptions: withOverride(defaultAssumptions(), 'availability.azCorrelation', correlation),
  };
}

function subnetIn(zone: string, suffix: string): IrNode {
  return {
    id: `subnet-${suffix}`,
    kind: 'subnet',
    name: `Private ${suffix}`,
    parent: 'vpc-main',
    layout: { x: 0, y: 0, width: 200, height: 200 },
    params: {
      tier: 'private',
      cidrBlock: `10.0.${suffix.charCodeAt(0)}.0/24`,
      availabilityZone: zone,
    },
  };
}

function serviceIn(subnetId: string, suffix: string): IrNode {
  return {
    id: `ecs-${suffix}`,
    kind: 'ecs_service',
    name: `API ${suffix}`,
    parent: subnetId,
    layout: { x: 0, y: 0 },
    params: { cpu: 512, memory: 1024, desiredCount: 1 },
  };
}

/** An ALB routing to one API replica per zone, which is the shape the parallel formula exists for. */
function replicatedAcross(zones: readonly string[]): ArchitectureIr {
  const document = threeTier();
  const original = document.nodes.filter(
    (node) => node.kind !== 'ecs_service' && node.kind !== 'rds_instance'
  );
  const edges: IrEdge[] = [];
  const replicas: IrNode[] = [];

  zones.forEach((zone, index) => {
    const suffix = String.fromCharCode('a'.charCodeAt(0) + index);
    replicas.push(subnetIn(zone, suffix), serviceIn(`subnet-${suffix}`, suffix));
    edges.push({
      id: `alb-to-${suffix}`,
      kind: 'routes_to',
      source: 'alb-public',
      target: `ecs-${suffix}`,
    });
  });

  return { ...document, nodes: [...original, ...replicas], edges };
}

function availabilityOf(document: ArchitectureIr, resourceId: string): number {
  const node = availability(document).value.nodes.find(
    (candidate) => candidate.resourceId === resourceId
  );
  if (node === undefined) throw new Error(`${resourceId} is not on the modelled path.`);
  return node.availability;
}

describe('series composition', () => {
  it('a series path is no better than its weakest component', () => {
    const report = availability(threeTier()).value;

    const weakest = Math.min(...report.nodes.map((node) => node.availability));
    expect(report.compositeAvailability).toBeLessThanOrEqual(weakest);
    expect(report.weakest).toBe('rds-primary');
  });

  it('adding a component to the path lowers availability', () => {
    const before = availability(threeTier()).value.compositeAvailability;

    const document = threeTier();
    document.nodes.push({
      id: 'cache-sessions',
      kind: 'elasticache_cluster',
      name: 'Session cache',
      parent: 'subnet-private-a',
      layout: { x: 400, y: 48 },
      params: { engine: 'valkey', nodeType: 'cache.t4g.micro', multiAz: false },
    });
    document.edges.push({
      id: 'api-to-cache',
      kind: 'connects',
      source: 'ecs-api',
      target: 'cache-sessions',
    });

    expect(availability(document).value.compositeAvailability).toBeLessThan(before);
  });

  it('multiplies rather than averaging, so the product is the composite', () => {
    const report = availability(threeTier()).value;

    const expected = report.nodes.reduce((product, node) => product * node.availability, 1);
    expect(report.compositeAvailability).toBeCloseTo(expected, 12);
  });

  it('treats an empty architecture as a gap rather than a prediction', () => {
    const document: ArchitectureIr = { ...threeTier(), nodes: [], edges: [] };

    const predictionOf = availability(document);

    expect(predictionOf.value.nodes).toEqual([]);
    expect(predictionOf.value.weakest).toBe('');
    expect(predictionOf.gaps.join()).toContain('Nothing on the request path could be modelled');
  });
});

describe('parallel composition', () => {
  it('three availability zones beat one', () => {
    const one = availability(replicatedAcross(['eu-west-1a'])).value;
    const three = availability(replicatedAcross(['eu-west-1a', 'eu-west-1b', 'eu-west-1c'])).value;

    expect(three.compositeAvailability).toBeGreaterThan(one.compositeAvailability);
    expect(three.nodes.find((node) => node.resourceId === 'ecs-a')?.azCount).toBe(3);
  });

  it('correlated failure lowers the parallel result below the independent formula', () => {
    const arms = [0.999, 0.999, 0.999];
    const independent = 1 - (1 - arms[0]!) ** 3;

    const correlated = parallelAvailability(arms, 0.1);

    expect(correlated).toBeLessThan(independent);
    // Eight nines is the answer nobody has observed; a tenth of failures being
    // common-cause brings it back to something an architecture has produced.
    expect(independent).toBeGreaterThan(0.999999);
    expect(correlated).toBeCloseTo(0.9999, 6);
  });

  it('zero correlation reproduces the independent formula', () => {
    const arms = [0.99, 0.995, 0.999];
    const independent = 1 - arms.reduce((product, arm) => product * (1 - arm), 1);

    expect(parallelAvailability(arms, 0)).toBeCloseTo(independent, 15);

    const zones = ['eu-west-1a', 'eu-west-1b', 'eu-west-1c'];
    const withCorrelation = availability(replicatedAcross(zones), contextWithCorrelation(0.1)).value
      .compositeAvailability;
    const withoutCorrelation = availability(replicatedAcross(zones), contextWithCorrelation(0))
      .value.compositeAvailability;

    expect(withoutCorrelation).toBeGreaterThan(withCorrelation);
  });

  it('gives one arm exactly its own availability', () => {
    expect(parallelAvailability([0.9995], 0.1)).toBeCloseTo(0.9995, 15);
    expect(parallelAvailability([0.9995], 0)).toBeCloseTo(0.9995, 15);
  });

  it('leaves total correlation worth no more than the worst arm', () => {
    expect(parallelAvailability([0.99, 0.9999], 1)).toBeCloseTo(0.99, 15);
  });

  it('earns no redundancy for replicas that share a zone', () => {
    const sameZone = availability(replicatedAcross(['eu-west-1a', 'eu-west-1a'])).value;
    const twoZones = availability(replicatedAcross(['eu-west-1a', 'eu-west-1b'])).value;

    expect(sameZone.compositeAvailability).toBeLessThan(twoZones.compositeAvailability);
    expect(sameZone.nodes.find((node) => node.resourceId === 'ecs-a')?.azCount).toBe(1);
  });

  it('does not group unconnected resources of the same kind as replicas', () => {
    const document = fourLevelChain();
    document.nodes.push({
      id: 'ecs-worker',
      kind: 'ecs_service',
      name: 'Worker',
      parent: 'cluster-main',
      layout: { x: 200, y: 48 },
      params: { cpu: 256, memory: 512, desiredCount: 1 },
    });

    const report = availability(document).value;

    expect(report.nodes.every((node) => node.azCount === 1)).toBe(true);
    // Two independent services in series, not one service with a spare.
    expect(report.compositeAvailability).toBeCloseTo(0.9999 * 0.9999, 12);
  });
});

describe('published commitments', () => {
  it('prefers a published sla over a computed value', () => {
    const document = threeTier();
    const database = document.nodes.find((node) => node.kind === 'rds_instance');
    if (database?.kind !== 'rds_instance') throw new Error('The fixture lost its database.');
    database.params.multiAz = true;

    const modelled = availability(document).value.nodes.find(
      (node) => node.resourceId === 'rds-primary'
    );

    expect(modelled?.basis).toBe('published');
    expect(modelled?.configuration).toBe('multi-az');
    expect(modelled?.availability).toBe(findSla('rds', 'multi-az')?.monthlyUptime);
  });

  it('distinguishes single-az from multi-az rds', () => {
    const single = threeTier();
    const multi = threeTier();
    const database = multi.nodes.find((node) => node.kind === 'rds_instance');
    if (database?.kind !== 'rds_instance') throw new Error('The fixture lost its database.');
    database.params.multiAz = true;

    expect(availabilityOf(single, 'rds-primary')).toBe(0.995);
    expect(availabilityOf(multi, 'rds-primary')).toBe(0.9995);
    expect(availabilityOf(single, 'rds-primary')).toBeLessThan(
      availabilityOf(multi, 'rds-primary')
    );
  });

  it('agrees with the rds resource contract on both configurations', () => {
    const contract = getResourceContract('rds_instance');
    if (contract === undefined) throw new Error('The RDS contract is not registered.');
    const params = {
      engine: 'postgres',
      instanceClass: 'db.t3.micro',
      allocatedStorageGb: 20,
    } as const;

    expect(contract.reliability({ ...params, multiAz: true }).availability).toBe(
      findSla('rds', 'multi-az')?.monthlyUptime
    );
    expect(contract.reliability({ ...params, multiAz: false }).availability).toBe(
      findSla('rds', 'single-az')?.monthlyUptime
    );
  });

  it('every entry in AWS_SLAS carries a source URL and a retrieval date', () => {
    for (const sla of AWS_SLAS) {
      expect(sla.source).toMatch(/^https:\/\/aws\.amazon\.com\//);
      expect(sla.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(sla.monthlyUptime).toBeGreaterThan(0.9);
      expect(sla.monthlyUptime).toBeLessThanOrEqual(1);
    }
  });

  it('holds one commitment per service and configuration', () => {
    const keys = AWS_SLAS.map((sla) => `${sla.serviceId}/${sla.configuration}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('finds nothing for a configuration nobody committed to', () => {
    expect(findSla('rds', 'serverless')).toBeUndefined();
    expect(findSla('kinesis', 'default')).toBeUndefined();
  });
});

describe('resources the model cannot reach', () => {
  it('reports an unmodelled resource rather than treating it as perfect', () => {
    const document = threeTier();
    document.nodes.push({
      id: 'queue-jobs',
      kind: 'sqs_queue',
      name: 'Job queue',
      layout: { x: 600, y: 48 },
      params: {},
    });
    document.edges.push({
      id: 'api-to-queue',
      kind: 'connects',
      source: 'ecs-api',
      target: 'queue-jobs',
    });

    const predictionOf = availability(document);

    expect(predictionOf.value.unmodelled).toEqual(['queue-jobs']);
    expect(predictionOf.value.nodes.some((node) => node.resourceId === 'queue-jobs')).toBe(false);
    expect(predictionOf.gaps.join()).toContain('no published SLA and no reliability model');
    expect(predictionOf.gaps.join()).toContain('the composite is better than the architecture is');
  });

  it('leaves configuration out of the path rather than calling it unmodelled', () => {
    const report = availability(threeTier()).value;

    const reached = new Set([...report.nodes.map((node) => node.resourceId), ...report.unmodelled]);
    expect(reached.has('vpc-main')).toBe(false);
    expect(reached.has('subnet-private-a')).toBe(false);
  });
});

describe('the reported figures', () => {
  it('reports downtime in minutes over the thirty day window an AWS SLA uses', () => {
    expect(MINUTES_PER_MONTH).toBe(30 * 24 * 60);

    const report = availability(threeTier()).value;

    expect(report.downtimeMinutesPerMonth).toBeCloseTo(
      (1 - report.compositeAvailability) * MINUTES_PER_MONTH,
      1
    );
    // 99.48% of thirty days is a little under four hours, which is what a
    // single-AZ database costs an otherwise well-built architecture.
    expect(report.downtimeMinutesPerMonth).toBeGreaterThan(200);
    expect(report.downtimeMinutesPerMonth).toBeLessThan(260);
  });

  it('lists resources in the order the architecture declares them', () => {
    const document = replicatedAcross(['eu-west-1a', 'eu-west-1b']);

    const order = availability(document).value.nodes.map((node) => node.resourceId);

    expect(order).toEqual(['alb-public', 'ecs-a', 'ecs-b']);
  });

  it('labels every figure as predicted and returns the same report twice', () => {
    const predictionOf = availability(threeTier());

    expect(predictionOf.label).toBe('Predicted');
    expect(predictionOf).toEqual(availability(threeTier()));
  });

  it('carries the correlation assumption only where something is in parallel', () => {
    const series = availability(threeTier());
    const parallel = availability(replicatedAcross(['eu-west-1a', 'eu-west-1b']));

    expect(series.assumptions).toEqual([]);
    expect(parallel.assumptions.map((assumption) => assumption.id)).toEqual([
      'availability.azCorrelation',
    ]);
    expect(parallel.assumptions[0]?.value).toBe(0.1);
  });

  it('warns when replicas are not placed in a zone', () => {
    const document = threeTier();
    for (const suffix of ['a', 'b']) {
      document.nodes.push({
        id: `lambda-${suffix}`,
        kind: 'lambda_function',
        name: `Handler ${suffix}`,
        layout: { x: 0, y: 0 },
        params: { runtime: 'nodejs20.x' },
      });
      document.edges.push({
        id: `alb-to-lambda-${suffix}`,
        kind: 'routes_to',
        source: 'alb-public',
        target: `lambda-${suffix}`,
      });
    }

    expect(availability(document).gaps.join()).toContain('not placed in an availability zone');
  });
});

describe('the series and parallel primitives', () => {
  it('returns an empty product for nothing in series', () => {
    expect(seriesAvailability([])).toBe(1);
    expect(parallelAvailability([], 0.1)).toBe(1);
  });

  it('multiplies a series of components', () => {
    expect(seriesAvailability([0.99, 0.999, 0.9999])).toBeCloseTo(0.99 * 0.999 * 0.9999, 15);
  });
});

describe('performance', () => {
  it('models a 40 resource architecture and its objectives in under 5ms', () => {
    const document = replicatedAcross(['eu-west-1a', 'eu-west-1b', 'eu-west-1c']);
    let index = 0;
    while (document.nodes.length < 40) {
      index += 1;
      document.nodes.push({
        id: `bucket-${index}`,
        kind: 's3_bucket',
        name: `Bucket ${index}`,
        layout: { x: 0, y: 0 },
        params: {},
      });
      document.edges.push({
        id: `api-to-bucket-${index}`,
        kind: 'connects',
        source: 'ecs-a',
        target: `bucket-${index}`,
      });
    }
    const ctx = availabilityContext('eu-west-1');

    for (let warmUp = 0; warmUp < 5; warmUp += 1) {
      proposeSlos(availability(document, ctx).value, { p95Ms: 120 });
    }

    const samples: number[] = [];
    for (let sample = 0; sample < 101; sample += 1) {
      const started = performance.now();
      const report = availability(document, ctx);
      proposeSlos(report.value, { p95Ms: 120 }, report.assumptions);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    expect(document.nodes).toHaveLength(40);
    expect(samples[50]).toBeLessThan(5);
  });
});
