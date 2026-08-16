import { assertValidIr } from '@infracanvas/ir-schema';
import type { ServiceNodeData } from '@infracanvas/core';
import type { Edge, Node } from 'reactflow';
import { describe, expect, it } from 'vitest';

import { estimateArchitecture } from './estimate';
import { canvasStoreToIr } from './to-ir';

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

describe('converting the canvas store to the IR', () => {
  it('produces a document the validator accepts', () => {
    const { document } = canvasStoreToIr(
      [
        node('vpc-1', 'vpc-environment', { cidrBlock: '10.0.0.0/16' }),
        node(
          'subnet-1',
          'private-subnet',
          { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' },
          'vpc-1'
        ),
        node('rds-1', 'rds', database, 'subnet-1'),
      ],
      []
    );

    expect(() => assertValidIr(document)).not.toThrow();
  });

  it('accepts the ids the palette actually generates', () => {
    // The fixtures above were written by hand and happened to be legal, so for
    // a long time nothing here exercised what the designer produces: React Flow
    // numbers a dropped service `node_0`, and the schema forbids underscores.
    // Every hand-drawn architecture was rejected by the API on that alone.
    const { document } = canvasStoreToIr(
      [
        node('node_0', 'vpc-environment', { cidrBlock: '10.0.0.0/16' }),
        node(
          'node_1',
          'private-subnet',
          { cidrBlock: '10.0.1.0/24', availabilityZone: 'us-east-1a' },
          'node_0'
        ),
        node('node_2', 'rds', database, 'node_1'),
      ],
      [
        {
          id: 'reactflow__edge-node_1-node_2',
          source: 'node_1',
          target: 'node_2',
        } as Edge,
      ]
    );

    expect(() => assertValidIr(document)).not.toThrow();
    // The nesting has to survive the renaming, or the subnet stops containing
    // the database and the availability model stops seeing a zone.
    expect(document.nodes[2]?.parent).toBe(document.nodes[1]?.id);
    expect(document.edges[0]?.source).toBe(document.nodes[1]?.id);
  });

  it('reads a subnet tier from which shape the canvas drew', () => {
    const { document } = canvasStoreToIr(
      [
        node('subnet-1', 'public-subnet', {
          cidrBlock: '10.0.1.0/24',
          availabilityZone: 'us-east-1a',
        }),
      ],
      []
    );

    expect(document.nodes[0]?.params).toMatchObject({ tier: 'public' });
  });

  it('names a service it cannot model rather than dropping it silently', () => {
    const { document, skipped } = canvasStoreToIr([node('waf-1', 'waf')], []);

    expect(document.nodes).toHaveLength(0);
    expect(skipped[0]?.reason).toContain('waf');
  });

  it('refuses a database missing a setting the price depends on', () => {
    const { skipped } = canvasStoreToIr([node('rds-1', 'rds', { engine: 'postgres' })], []);

    expect(skipped[0]?.reason).toContain('missing a setting');
  });

  it('refuses a subnet with no availability zone rather than choosing one', () => {
    // The zone decides whether the availability model treats two replicas as
    // able to fail together, so guessing it would quietly decide the answer.
    const { skipped } = canvasStoreToIr(
      [node('subnet-1', 'private-subnet', { cidrBlock: '10.0.1.0/24' })],
      []
    );

    expect(skipped[0]?.reason).toContain('missing a setting');
  });

  it('drops a parent reference to a node that was skipped', () => {
    // Otherwise the child names a parent the document does not contain, which
    // the validator rejects outright and the panel would show as an error.
    const { document } = canvasStoreToIr(
      [node('waf-1', 'waf'), node('rds-1', 'rds', database, 'waf-1')],
      []
    );

    expect(document.nodes[0]?.parent).toBeUndefined();
    expect(() => assertValidIr(document)).not.toThrow();
  });

  it('drops an edge whose endpoint was skipped', () => {
    const edges: Edge[] = [{ id: 'e1', source: 'rds-1', target: 'waf-1' }];

    const { document } = canvasStoreToIr(
      [node('waf-1', 'waf'), node('rds-1', 'rds', database)],
      edges
    );

    expect(document.edges).toHaveLength(0);
  });

  it('raises a storage figure below what RDS will provision', () => {
    const { document, skipped } = canvasStoreToIr(
      [node('rds-1', 'rds', { ...database, allocatedStorage: 5 })],
      []
    );

    expect(skipped).toHaveLength(0);
    expect(document.nodes[0]?.params).toMatchObject({ allocatedStorageGb: 20 });
  });
});

describe('estimating an architecture', () => {
  function threeTierStore() {
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
      ],
      []
    ).document;
  }

  it('prices the database and says what it could not price', () => {
    const estimate = estimateArchitecture(threeTierStore());

    expect(estimate.cost.value.monthlyUsd).toBeGreaterThan(0);
    expect(estimate.cost.value.unpriced.join()).toContain('vpc-1');
  });

  it('labels every figure as predicted', () => {
    const estimate = estimateArchitecture(threeTierStore());

    expect(estimate.cost.label).toBe('Predicted');
    expect(estimate.availability.label).toBe('Predicted');
    expect(estimate.slos.label).toBe('Predicted');
  });

  it('proposes no objective above the availability it modelled', () => {
    const estimate = estimateArchitecture(threeTierStore());

    for (const proposal of estimate.slos.value) {
      if (proposal.objective !== 'availability') continue;
      expect(proposal.target).toBeLessThanOrEqual(
        estimate.availability.value.compositeAvailability
      );
    }
  });

  it('reports a single availability zone database as a reliability finding', () => {
    const estimate = estimateArchitecture(threeTierStore());

    expect(estimate.findings.byPillar.reliability.map((finding) => finding.ruleId)).toContain(
      'RDS-REL-001'
    );
  });

  it('moves the total when an assumption is overridden', () => {
    const document = threeTierStore();

    const full = estimateArchitecture(document);
    const half = estimateArchitecture(document, new Map([['time.hoursPerMonth', 365]]));

    expect(half.cost.value.monthlyUsd).toBeLessThan(full.cost.value.monthlyUsd);
    expect(half.assumptions.find((a) => a.id === 'time.hoursPerMonth')?.source).toBe('user');
  });

  it('raises the modelled availability when the database spans two zones', () => {
    const single = estimateArchitecture(threeTierStore());
    const multiAz = canvasStoreToIr(
      [node('rds-1', 'rds', { ...database, multiAz: true })],
      []
    ).document;

    expect(estimateArchitecture(multiAz).availability.value.compositeAvailability).toBeGreaterThan(
      single.availability.value.compositeAvailability
    );
  });

  it('refuses an override for an assumption nothing reads', () => {
    expect(() => estimateArchitecture(threeTierStore(), new Map([['traffic.rps', 5]]))).toThrow(
      /No assumption is registered/
    );
  });

  it('predicts latency along the same path availability reasoned about', () => {
    const estimate = estimateArchitecture(threeTierStore());

    // One path or none: two models disagreeing about which resources a request
    // passes through would be two answers about one architecture.
    expect(estimate.latency?.value.path).toEqual(
      estimate.availability.value.nodes.map((node) => node.resourceId)
    );
    expect(estimate.latency?.value.p95Ms).toBeGreaterThan(estimate.latency!.value.p50Ms);
  });

  it('proposes a latency objective once a path has been modelled', () => {
    const estimate = estimateArchitecture(threeTierStore());

    const latencySlo = estimate.slos.value.find((proposal) => proposal.objective === 'latency');
    expect(latencySlo).toBeDefined();
    expect(latencySlo!.target).toBeGreaterThan(0);
  });

  it('predicts no latency when nothing on the path carries a service time', () => {
    const { document } = canvasStoreToIr(
      [node('vpc-1', 'vpc-environment', { cidrBlock: '10.0.0.0/16' })],
      []
    );

    const estimate = estimateArchitecture(document);

    expect(estimate.latency).toBeNull();
    // And no objective is invented from the absence.
    expect(estimate.slos.value.some((proposal) => proposal.objective === 'latency')).toBe(false);
  });

  it('names the resource that gives way first and the rate it gives way at', () => {
    const estimate = estimateArchitecture(threeTierStore());

    const { first } = estimate.bottleneck.value;
    if (first !== null) {
      expect(first.resourceId).not.toBe('');
      expect(first.breakingRps).toBeGreaterThan(0);
      expect(first.remedy).not.toBe('');
    }
  });

  it('recomputes an estimate for a 40 node architecture in under 50ms', () => {
    const nodes = [node('vpc-1', 'vpc-environment', { cidrBlock: '10.0.0.0/16' })];
    while (nodes.length < 40) nodes.push(node(`rds-${nodes.length}`, 'rds', database, 'vpc-1'));
    const { document } = canvasStoreToIr(nodes, []);

    for (let warmUp = 0; warmUp < 3; warmUp += 1) estimateArchitecture(document);

    const samples: number[] = [];
    for (let sample = 0; sample < 11; sample += 1) {
      const started = performance.now();
      estimateArchitecture(document, new Map([['time.hoursPerMonth', 700 + sample]]));
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    // 1.8ms here with cost, availability, latency and the bottleneck sweep all
    // included. The ceiling is far above it because CI runs every package's
    // suite at once on a small runner; what a budget can still catch at this
    // distance is the order-of-magnitude kind, such as re-reading the price
    // snapshot per node.
    expect(samples[5]).toBeLessThan(50);
  });
});
