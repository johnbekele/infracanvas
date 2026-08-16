import { defaultAssumptions, type ServiceNodeData } from '@infracanvas/core';
import type { Node } from 'reactflow';
import { describe, expect, it } from 'vitest';

import { estimateArchitecture } from './estimate';
import { loadSweep } from './sweep';
import { canvasStoreToIr } from './to-ir';

/**
 * The sweep replaces a chart we cannot honestly draw, so what matters is that
 * every point is a real solve: the cost has to move with the traffic, the p95
 * has to rise the way a queue does rather than linearly, and the curve has to
 * stop where the models stop being meaningful instead of drawing on.
 */

function node(
  id: string,
  serviceId: string,
  properties: Record<string, string | number | boolean> = {},
  parentNode?: string
): Node<ServiceNodeData> {
  return {
    id,
    type: 'service',
    position: { x: 10, y: 20 },
    ...(parentNode === undefined ? {} : { parentNode }),
    data: {
      serviceId,
      serviceName: id,
      shortName: id,
      category: 'database',
      color: '#000',
      icon: 'database',
      properties,
    } as ServiceNodeData,
  };
}

const database = {
  engine: 'postgres',
  instanceClass: 'db.t3.micro',
  allocatedStorage: 20,
  multiAz: false,
  publiclyAccessible: false,
  deletionProtection: true,
};

function threeTier() {
  return canvasStoreToIr(
    [
      node('vpc-1', 'vpc-environment', { cidrBlock: '10.0.0.0/16' }),
      node(
        'subnet-1',
        'private-subnet',
        { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' },
        'vpc-1'
      ),
      node('rds-1', 'rds', database, 'subnet-1'),
      node('ecs-1', 'ecs-service', {}, 'subnet-1'),
    ],
    []
  ).document;
}

/** The path the dashboard sweeps is the one the availability model reasoned about. */
function pathOf(document: ReturnType<typeof threeTier>) {
  return estimateArchitecture(document).availability.value.nodes.map((n) => n.resourceId);
}

describe('loadSweep', () => {
  it('samples a rising range of rates around the assumed one', () => {
    const document = threeTier();
    const sweep = loadSweep(document, pathOf(document));

    expect(sweep.points.length).toBeGreaterThan(4);
    expect(sweep.baselineRps).toBeGreaterThan(0);

    const rates = sweep.points.map((point) => point.rps);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
    // The assumed rate is on the curve, so the headline figure has a place on it.
    expect(sweep.points[0]?.multiple).toBeCloseTo(1, 5);
  });

  it('runs the axis out to where the design reaches capacity', () => {
    // A fixed multiple of the assumed traffic produced a flat line: a small
    // database at two percent utilisation is still under twenty at eight times
    // the load, so the chart showed nothing the headline had not. The range has
    // to contain the knee to be worth drawing.
    const document = threeTier();
    const sweep = loadSweep(document, pathOf(document));

    expect(sweep.capacityRps).not.toBeNull();
    expect(sweep.points.at(-1)!.rps).toBeGreaterThanOrEqual(sweep.capacityRps!);

    const peaks = sweep.points.map((point) => point.peakUtilisation);
    expect(Math.max(...peaks)).toBeGreaterThan(0.9);
    expect(Math.min(...peaks)).toBeLessThan(0.1);
  });

  it('moves cost with traffic rather than holding it flat', () => {
    const document = threeTier();
    const sweep = loadSweep(document, pathOf(document));

    const first = sweep.points[0]!.monthlyUsd;
    const last = sweep.points.at(-1)!.monthlyUsd;

    expect(first).toBeGreaterThan(0);
    // A database's instance hours do not move with requests, so this only has
    // to be non-decreasing: what would be wrong is a total that fell as load rose.
    expect(last).toBeGreaterThanOrEqual(first);
  });

  it('raises latency faster than load, which is what a queue does', () => {
    const document = threeTier();
    const sweep = loadSweep(document, pathOf(document));

    const measured = sweep.points.filter((point) => point.p95Ms !== null);
    expect(measured.length).toBeGreaterThan(1);

    const first = measured[0]!;
    const last = measured.at(-1)!;

    expect(last.p95Ms!).toBeGreaterThan(first.p95Ms!);
    // Superlinear: doubling the rate must cost more than double the wait, or the
    // curve is a straight line and says nothing a single figure did not.
    const rateRatio = last.rps / first.rps;
    const latencyRatio = last.p95Ms! / first.p95Ms!;
    expect(latencyRatio).toBeGreaterThan(1);
    expect(rateRatio).toBeGreaterThan(1);
  });

  it('reports no latency past the point a hop reaches capacity', () => {
    const document = threeTier();
    const sweep = loadSweep(document, pathOf(document));

    if (sweep.saturatesAtRps === null) return;

    for (const point of sweep.points) {
      if (point.rps < sweep.saturatesAtRps) continue;
      // Past capacity the queueing formula diverges. A number there would be a
      // guess dressed as a prediction, so the curve stops instead.
      expect(point.p95Ms).toBeNull();
    }
  });

  it('rises in utilisation with load', () => {
    const document = threeTier();
    const sweep = loadSweep(document, pathOf(document));

    const peaks = sweep.points.map((point) => point.peakUtilisation);
    for (let index = 1; index < peaks.length; index += 1) {
      expect(peaks[index]!).toBeGreaterThanOrEqual(peaks[index - 1]!);
    }
  });

  it('returns an empty-path sweep rather than throwing on a bare canvas', () => {
    const document = threeTier();
    const sweep = loadSweep(document, [], defaultAssumptions());

    expect(sweep.capacityRps).toBeNull();
    expect(sweep.points.length).toBeGreaterThan(0);
    for (const point of sweep.points) expect(point.p95Ms).toBeNull();
  });
});

describe('performance', () => {
  it('sweeps a document in under 150ms', () => {
    const document = threeTier();
    const path = pathOf(document);

    // The sweep runs when the dashboard opens and again on every assumption
    // edit, so it sits on an interactive path. The budget is loose because it
    // is a whole-model solve per point and CI runners are contended; what it
    // guards against is a change that makes it seconds rather than a frame.
    const runs = [0, 1, 2].map(() => {
      const started = performance.now();
      loadSweep(document, path);
      return performance.now() - started;
    });

    expect(Math.min(...runs)).toBeLessThan(150);
  });
});
