import { describe, expect, it } from 'vitest';
import type { Node } from 'reactflow';
import {
  absolutePosition,
  canNest,
  containerAt,
  descendantIds,
  grownSize,
  positionWithin,
  sizeOf,
} from './containment';
import type { ServiceNodeData } from '@/lib/stores/designer-store';

function node(
  id: string,
  serviceId: string,
  position: { x: number; y: number },
  options: { parentNode?: string; width?: number; height?: number } = {}
): Node<ServiceNodeData> {
  return {
    id,
    position,
    parentNode: options.parentNode,
    width: options.width,
    height: options.height,
    style: options.width ? { width: options.width, height: options.height } : undefined,
    data: {
      serviceId,
      serviceName: serviceId,
      shortName: serviceId,
      color: '#000000',
      category: 'compute',
      properties: {},
    },
  } as Node<ServiceNodeData>;
}

/** A VPC at the origin, a private subnet inside it, a cluster inside that. */
function nested(): Node<ServiceNodeData>[] {
  return [
    node('vpc', 'vpc-environment', { x: 100, y: 100 }, { width: 800, height: 600 }),
    node(
      'subnet',
      'private-subnet',
      { x: 50, y: 60 },
      { parentNode: 'vpc', width: 400, height: 300 }
    ),
    node(
      'cluster',
      'ecs-cluster',
      { x: 20, y: 40 },
      { parentNode: 'subnet', width: 200, height: 160 }
    ),
  ];
}

describe('absolutePosition', () => {
  it('adds up the whole parent chain', () => {
    const nodes = nested();
    expect(absolutePosition(nodes[2], nodes)).toEqual({ x: 170, y: 200 });
  });

  it('leaves an unparented node where it is', () => {
    const nodes = nested();
    expect(absolutePosition(nodes[0], nodes)).toEqual({ x: 100, y: 100 });
  });

  it('terminates when parent links form a cycle', () => {
    const nodes = [
      node('a', 'ecs', { x: 0, y: 0 }, { parentNode: 'b' }),
      node('b', 'ecs', { x: 0, y: 0 }, { parentNode: 'a' }),
    ];
    expect(absolutePosition(nodes[0], nodes)).toBeDefined();
  });
});

describe('containerAt', () => {
  it('picks the innermost container under the point', () => {
    const nodes = nested();
    expect(containerAt({ x: 200, y: 240 }, nodes)?.id).toBe('cluster');
  });

  it('falls back to the enclosing subnet outside the cluster', () => {
    const nodes = nested();
    expect(containerAt({ x: 400, y: 400 }, nodes)?.id).toBe('subnet');
  });

  it('returns nothing on open canvas', () => {
    const nodes = nested();
    expect(containerAt({ x: 2000, y: 2000 }, nodes)).toBeNull();
  });

  it('never offers a container inside the node being dragged', () => {
    const nodes = nested();
    expect(containerAt({ x: 200, y: 240 }, nodes, 'vpc')).toBeNull();
  });
});

describe('canNest', () => {
  it('keeps a subnet out of anything that is not a VPC', () => {
    expect(canNest('private-subnet', 'vpc-environment')).toBe(true);
    expect(canNest('private-subnet', 'ecs-cluster')).toBe(false);
    expect(canNest('private-subnet', null)).toBe(false);
  });

  it('starts a zone on open canvas, since nothing encloses a failure domain', () => {
    expect(canNest('availability-zone', null)).toBe(true);
    expect(canNest('availability-zone', 'vpc-environment')).toBe(false);
    expect(canNest('availability-zone', 'private-subnet')).toBe(false);
  });

  it('draws a VPC inside a zone or on its own, and nowhere else', () => {
    expect(canNest('vpc-environment', 'availability-zone')).toBe(true);
    expect(canNest('vpc-environment', null)).toBe(true);
    expect(canNest('vpc-environment', 'private-subnet')).toBe(false);
  });

  it('accepts a VPC dropped on the zone, the way the canvas asks', () => {
    const nodes = [node('zone', 'availability-zone', { x: 0, y: 0 }, { width: 580, height: 520 })];
    const container = containerAt({ x: 100, y: 100 }, nodes);

    expect(container?.id).toBe('zone');
    expect(canNest('vpc-environment', container?.data.serviceId ?? null)).toBe(true);
  });

  it('refuses a subnet dropped in the zone but outside the VPC', () => {
    expect(canNest('public-subnet', 'availability-zone')).toBe(false);
  });

  it('keeps a cluster in a subnet rather than loose in a zone', () => {
    expect(canNest('ecs-cluster', 'private-subnet')).toBe(true);
    expect(canNest('ecs-cluster', 'availability-zone')).toBe(false);
    expect(canNest('eks-cluster', 'availability-zone')).toBe(false);
  });

  it('keeps a database out of a public subnet', () => {
    expect(canNest('rds', 'private-subnet')).toBe(true);
    expect(canNest('rds', 'public-subnet')).toBe(false);
  });

  it('requires a subnet for services that cannot exist without one', () => {
    expect(canNest('nat-gateway', null)).toBe(false);
    expect(canNest('nat-gateway', 'public-subnet')).toBe(true);
  });

  it('honours the explicit parent list a service declares', () => {
    expect(canNest('fargate', 'ecs-cluster')).toBe(true);
    expect(canNest('fargate', 'vpc-environment')).toBe(false);
  });

  it('rejects a service the catalog has never heard of', () => {
    expect(canNest('not-a-service', null)).toBe(false);
  });
});

describe('grownSize', () => {
  it('grows to fit a child placed past the edge', () => {
    const grown = grownSize({ width: 200, height: 200 }, [
      { position: { x: 150, y: 20 }, size: { width: 144, height: 96 } },
    ]);

    expect(grown.width).toBeGreaterThan(200);
    expect(grown.height).toBe(200);
  });

  it('never shrinks, so dragging one node out does not reflow the rest', () => {
    const grown = grownSize({ width: 800, height: 600 }, [
      { position: { x: 10, y: 10 }, size: { width: 40, height: 40 } },
    ]);

    expect(grown).toEqual({ width: 800, height: 600 });
  });
});

describe('positionWithin', () => {
  it('keeps a reparented node where the user dropped it', () => {
    const nodes = nested();
    const inside = positionWithin({ x: 300, y: 400 }, nodes[1], nodes);

    expect(
      absolutePosition(
        { ...nodes[1], id: 'x', position: inside, parentNode: 'subnet' } as Node<ServiceNodeData>,
        nodes
      )
    ).toEqual({
      x: 300,
      y: 400,
    });
  });

  it('leaves a node dropped on open canvas alone', () => {
    const nodes = nested();
    expect(positionWithin({ x: 12, y: 34 }, null, nodes)).toEqual({ x: 12, y: 34 });
  });
});

describe('sizeOf and descendantIds', () => {
  it('falls back to a sensible size for an unmeasured container', () => {
    expect(sizeOf(node('c', 'ecs-cluster', { x: 0, y: 0 }))).toEqual({ width: 240, height: 200 });
  });

  it('collects children at every depth', () => {
    expect(descendantIds('vpc', nested())).toEqual(new Set(['subnet', 'cluster']));
  });
});
