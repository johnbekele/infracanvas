import { assertValidIr, type ArchitectureIr, type IrNode } from '@infracanvas/ir-schema';
import { describe, expect, it } from 'vitest';

import { canvasToIr, clusterIdFor, irToCanvas } from './canvas';
import { fixture, fixtureNames, fourLevelChain, threeTier } from './fixtures';
import { normaliseCanvas, normaliseIr } from './normalise';

/** A document large enough that an accidental quadratic in the conversion shows up. */
function wide(nodeCount: number): ArchitectureIr {
  const nodes: IrNode[] = [
    {
      id: 'vpc-main',
      kind: 'vpc',
      name: 'Main VPC',
      layout: { x: 0, y: 0, width: 4000, height: 4000 },
      params: { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true },
    },
  ];

  for (let index = 0; index < nodeCount; index += 1) {
    nodes.push({
      id: `subnet-${index}`,
      kind: 'subnet',
      name: `Subnet ${index}`,
      parent: 'vpc-main',
      layout: { x: (index % 20) * 200, y: Math.floor(index / 20) * 120, width: 180, height: 100 },
      params: {
        tier: index % 2 === 0 ? 'public' : 'private',
        cidrBlock: `10.0.${index % 256}.0/24`,
        availabilityZone: 'eu-west-1a',
      },
    });
  }

  return assertValidIr({
    irVersion: threeTier().irVersion,
    name: 'Wide',
    provider: 'aws',
    region: 'eu-west-1',
    nodes,
    edges: [],
    presentation: { viewport: { x: 0, y: 0, zoom: 1 } },
  });
}

/** The median of repeated runs: one sample on a shared CI runner measures the runner's neighbours. */
function medianMs(run: () => void): number {
  for (let warmUp = 0; warmUp < 5; warmUp += 1) run();

  const samples: number[] = [];
  for (let sample = 0; sample < 11; sample += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[5];
}

describe('round trip', () => {
  const names = fixtureNames();

  it('has fixtures to round trip, so an empty directory cannot pass silently', () => {
    expect(names).toContain('three-tier');
    expect(names.length).toBeGreaterThan(1);
  });

  it.each(names)('round trips every ir fixture without loss: %s', (name) => {
    const ir = fixture(name);
    expect(normaliseIr(canvasToIr(irToCanvas(ir)))).toEqual(normaliseIr(ir));
  });

  it('round trips a canvas graph through the ir and back', () => {
    for (const name of names) {
      const graph = irToCanvas(fixture(name));
      expect(normaliseCanvas(irToCanvas(canvasToIr(graph))), name).toEqual(normaliseCanvas(graph));
    }
  });

  it('preserves the vpc subnet cluster service containment chain', () => {
    const ir = fourLevelChain();
    const round = canvasToIr(irToCanvas(ir));

    const parents = Object.fromEntries(round.nodes.map((node) => [node.id, node.parent ?? null]));
    expect(parents).toEqual({
      'vpc-main': null,
      'subnet-private-a': 'vpc-main',
      'cluster-main': 'subnet-private-a',
      'ecs-api': 'cluster-main',
    });
    expect(normaliseIr(round)).toEqual(normaliseIr(ir));
  });

  it('keeps child positions relative to their parent', () => {
    const graph = irToCanvas(fourLevelChain());
    const service = graph.nodes.find((node) => node.id === 'ecs-api')!;

    // 20,48 is measured from the cluster, not from the canvas origin, so a
    // conversion that resolved positions to absolute would read 76,160 here.
    expect(service.position).toEqual({ x: 20, y: 48 });
    expect(service.parentNode).toBe('cluster-main');

    const back = canvasToIr(graph).nodes.find((node) => node.id === 'ecs-api');
    expect(back?.layout).toMatchObject({ x: 20, y: 48 });
    expect(back?.parent).toBe('cluster-main');
  });

  it('expands a legacy single ecs node into a cluster and a service with stable ids', () => {
    // three-tier draws the service straight into a subnet, as the canvas allows.
    const once = canvasToIr(irToCanvas(threeTier()));
    const cluster = once.nodes.find((node) => node.id === clusterIdFor('ecs-api'));

    expect(cluster?.kind).toBe('ecs_cluster');
    expect(cluster?.parent).toBe('subnet-private-a');
    expect(once.nodes.find((node) => node.id === 'ecs-api')?.parent).toBe(cluster?.id);

    const twice = canvasToIr(irToCanvas(once));
    expect(twice.nodes.map((node) => node.id)).toEqual(once.nodes.map((node) => node.id));
  });

  it('reaches a fixed point after one pass, so repeated saves stop changing the document', () => {
    const once = normaliseIr(canvasToIr(irToCanvas(threeTier())));
    expect(normaliseIr(canvasToIr(irToCanvas(once)))).toEqual(once);
  });

  it('keeps the result valid at every hop', () => {
    const ir = canvasToIr(irToCanvas(threeTier()));
    expect(assertValidIr(ir)).toEqual(ir);
    expect(assertValidIr(canvasToIr(irToCanvas(ir)))).toBeDefined();
  });

  it('preserves the viewport, which is presentation the IR still owns', () => {
    const ir = threeTier();
    ir.presentation = { viewport: { x: -120, y: 40, zoom: 1.75 } };

    const graph = irToCanvas(ir);
    expect(graph.viewport).toEqual({ x: -120, y: 40, zoom: 1.75 });
    expect(canvasToIr(graph).presentation?.viewport).toEqual({ x: -120, y: 40, zoom: 1.75 });
  });

  it('preserves every parameter value rather than only the ones the canvas renders', () => {
    // Compared against the fixture rather than a literal: the canvas draws a
    // handful of these, and the ones it does not draw are exactly the ones a
    // lossy conversion would quietly drop.
    const before = threeTier().nodes.find((node) => node.id === 'rds-primary');
    const after = canvasToIr(irToCanvas(threeTier())).nodes.find(
      (node) => node.id === 'rds-primary'
    );

    expect(Object.keys(after?.params ?? {}).length).toBeGreaterThan(5);
    expect(after?.params).toEqual(before?.params);
  });

  it('converts a 500 node document in under 20ms in each direction', () => {
    const ir = wide(499);
    const graph = irToCanvas(ir);

    expect(medianMs(() => irToCanvas(ir))).toBeLessThan(20);
    expect(medianMs(() => canvasToIr(graph))).toBeLessThan(20);
  });
});

describe('normalisation', () => {
  it('is idempotent, so it cannot itself be the source of a difference', () => {
    const once = normaliseIr(threeTier());
    expect(normaliseIr(once)).toEqual(once);
  });

  it('treats an absent parent and an explicit null as the same root node', () => {
    const withNull = threeTier();
    withNull.nodes[0] = { ...withNull.nodes[0], parent: null } as IrNode;

    expect(normaliseIr(withNull)).toEqual(normaliseIr(threeTier()));
  });

  it('ignores node and edge ordering', () => {
    const shuffled = threeTier();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();

    expect(normaliseIr(shuffled)).toEqual(normaliseIr(threeTier()));
  });

  it('does not paper over a difference that matters', () => {
    const changed = threeTier();
    const rds = changed.nodes.find((node) => node.id === 'rds-primary')!;
    rds.params = { ...rds.params, multiAz: true };

    expect(normaliseIr(changed)).not.toEqual(normaliseIr(threeTier()));
  });

  it('leaves a normalised canvas mountable, with parents still ahead of children', () => {
    const graph = normaliseCanvas(irToCanvas(threeTier()));
    const index = new Map(graph.nodes.map((node, position) => [node.id, position]));

    for (const node of graph.nodes) {
      if (!node.parentNode) continue;
      expect(index.get(node.parentNode)!).toBeLessThan(index.get(node.id)!);
    }
  });
});
