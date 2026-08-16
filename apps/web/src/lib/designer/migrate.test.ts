import { describe, expect, it } from 'vitest';
import type { Node } from 'reactflow';
import { detachIllegalParents } from './migrate';
import type { ServiceNodeData } from '@/lib/stores/designer-store';

function node(
  id: string,
  serviceId: string,
  position: { x: number; y: number },
  parentNode?: string
): Node<ServiceNodeData> {
  return {
    id,
    position,
    parentNode,
    data: {
      serviceId,
      serviceName: serviceId,
      shortName: serviceId,
      color: '#000000',
      category: 'networking',
      properties: {},
      parentId: parentNode,
    },
  } as Node<ServiceNodeData>;
}

describe('detachIllegalParents', () => {
  it('frees a zone that an older design drew inside a VPC', () => {
    const migrated = detachIllegalParents([
      node('vpc', 'vpc-environment', { x: 100, y: 200 }),
      node('zone', 'availability-zone', { x: 30, y: 40 }, 'vpc'),
    ]);

    expect(migrated[1].parentNode).toBeUndefined();
    expect(migrated[1].data.parentId).toBeUndefined();
    expect(migrated[1].extent).toBeUndefined();
  });

  it('leaves the freed node where it was drawn', () => {
    const migrated = detachIllegalParents([
      node('vpc', 'vpc-environment', { x: 100, y: 200 }),
      node('zone', 'availability-zone', { x: 30, y: 40 }, 'vpc'),
    ]);

    expect(migrated[1].position).toEqual({ x: 130, y: 240 });
  });

  it('keeps nesting the rules still allow', () => {
    const nodes = [
      node('zone', 'availability-zone', { x: 0, y: 0 }),
      node('vpc', 'vpc-environment', { x: 30, y: 60 }, 'zone'),
      node('subnet', 'private-subnet', { x: 20, y: 40 }, 'vpc'),
    ];

    expect(detachIllegalParents(nodes)).toEqual(nodes);
  });

  it('drops a parent link pointing at a node that is gone', () => {
    const migrated = detachIllegalParents([
      node('subnet', 'private-subnet', { x: 20, y: 40 }, 'deleted-vpc'),
    ]);

    expect(migrated[0].parentNode).toBeUndefined();
  });
});
