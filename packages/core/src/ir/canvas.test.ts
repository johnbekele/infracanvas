import type { ArchitectureIr } from '@infracanvas/ir-schema';
import { describe, expect, it } from 'vitest';

import { canvasToIr, CanvasConversionError, clusterIdFor, irToCanvas } from './canvas';
import { threeTier } from './fixtures';

describe('irToCanvas', () => {
  it('orders parents before children so react flow can mount them', () => {
    const { nodes } = irToCanvas(threeTier());
    const index = new Map(nodes.map((node, position) => [node.id, position]));

    for (const node of nodes) {
      if (!node.parentNode) continue;
      expect(index.get(node.parentNode)!, node.id).toBeLessThan(index.get(node.id)!);
    }
  });

  it('resolves presentation from the catalogue rather than storing it', () => {
    const alb = irToCanvas(threeTier()).nodes.find((node) => node.id === 'alb-public');

    expect(alb?.data.service).toEqual({
      serviceId: 'alb',
      serviceName: 'Application Load Balancer',
      shortName: 'ALB',
      color: expect.any(String),
      category: 'networking',
    });
  });

  it('refuses to convert an ir kind the canvas cannot render', () => {
    const ir = threeTier();
    ir.nodes.push({
      id: 'igw-main',
      kind: 'internet_gateway',
      name: 'Internet gateway',
      parent: 'vpc-main',
      params: {},
    });

    expect(() => irToCanvas(ir)).toThrow(CanvasConversionError);
    try {
      irToCanvas(ir);
    } catch (error) {
      expect((error as CanvasConversionError).message).toContain('internet_gateway');
    }
  });

  it('rejects a document whose parent chain contains a cycle', () => {
    const ir = threeTier();
    ir.nodes[0].parent = 'subnet-public-a';

    expect(() => irToCanvas(ir)).toThrow(/cycle/i);
  });

  it('carries container size across as a react flow style', () => {
    const vpc = irToCanvas(threeTier()).nodes.find((node) => node.id === 'vpc-main');
    expect(vpc?.style).toEqual({ width: 960, height: 640 });
  });
});

describe('canvasToIr', () => {
  it('rejects a canvas node whose parent is missing rather than emitting an orphan', () => {
    const graph = irToCanvas(threeTier());
    graph.nodes = graph.nodes.filter((node) => node.id !== 'vpc-main');

    expect(() => canvasToIr(graph)).toThrow(CanvasConversionError);
    try {
      canvasToIr(graph);
    } catch (error) {
      expect((error as CanvasConversionError).problems[0].pointer).toContain('parent');
    }
  });

  it('throws with the validator problems when its output would be invalid', () => {
    const graph = irToCanvas(threeTier());
    graph.edges[0].target = 'ecs-worker';

    try {
      canvasToIr(graph);
      expect.unreachable('expected canvasToIr to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasConversionError);
      expect((error as CanvasConversionError).problems).toContainEqual(
        expect.objectContaining({ source: 'reference' })
      );
    }
  });

  it('rounds a position a drag left at sub-pixel precision', () => {
    const graph = irToCanvas(threeTier());
    graph.nodes[0].position = { x: 12.4999, y: -3.5 };

    const ir = canvasToIr(graph);
    expect(ir.nodes[0].layout).toMatchObject({ x: 12, y: -3 });
  });

  it('leaves a service alone when it already sits in a cluster', () => {
    const ir = threeTier();
    ir.nodes.push({
      id: 'cluster-main',
      kind: 'ecs_cluster',
      name: 'Main cluster',
      parent: 'subnet-private-a',
      params: {},
    });
    const api = ir.nodes.find((node) => node.id === 'ecs-api')!;
    api.parent = 'cluster-main';

    const converted = canvasToIr(irToCanvas(ir));
    expect(converted.nodes.some((node) => node.id === clusterIdFor('ecs-api'))).toBe(false);
  });

  it('keeps edge label and handles unchanged in both directions', () => {
    const ir = threeTier();
    ir.edges[0].sourceHandle = 'right';
    ir.edges[0].targetHandle = 'left';

    const round: ArchitectureIr = canvasToIr(irToCanvas(ir));
    const edge = round.edges.find((candidate) => candidate.id === 'alb-to-api');

    expect(edge).toMatchObject({ label: 'HTTPS', sourceHandle: 'right', targetHandle: 'left' });
  });
});
