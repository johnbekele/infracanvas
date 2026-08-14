import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import type { ArchitectureIr } from '@infracanvas/core';

import type { ServiceNodeData } from '@/lib/stores/designer-store';

import { applyIrToFlow } from './ir-to-flow';

/**
 * The canvas owns position and the document owns everything else. These tests
 * are mostly about the first half of that sentence: a patch that moved nodes
 * the user had arranged would make accepting one feel like losing work, and
 * that is the failure the merge exists to prevent.
 */

const REGION = 'eu-west-1'; // infracanvas-allow: no-hardcoded-region

function ir(nodes: ArchitectureIr['nodes'], edges: ArchitectureIr['edges'] = []): ArchitectureIr {
  return {
    irVersion: '1.2.0',
    name: 'test',
    region: REGION,
    nodes,
    edges,
  } as ArchitectureIr;
}

type IrNode = ArchitectureIr['nodes'][number];

function database(id: string, multiAz = false): IrNode {
  return {
    id,
    kind: 'rds_instance',
    name: 'db',
    params: {
      engine: 'postgres',
      instanceClass: 'db.t3.micro',
      allocatedStorageGb: 20,
      multiAz,
      publiclyAccessible: false,
    },
  };
}

function bucket(id: string): IrNode {
  return { id, kind: 's3_bucket', name: 'assets', params: {} };
}

function placed(id: string, x: number, y: number): Node<ServiceNodeData> {
  return {
    id,
    type: 'serviceNode',
    position: { x, y },
    data: {
      serviceId: 'rds',
      serviceName: 'RDS',
      shortName: 'RDS',
      color: '#000',
      category: 'Database',
      properties: {},
      nodeType: 'service',
    },
  } as Node<ServiceNodeData>;
}

describe('applyIrToFlow', () => {
  it('leaves a node the user positioned exactly where they put it', () => {
    const current = { nodes: [placed('db', 412, 233)], edges: [] as Edge[] };

    const { nodes } = applyIrToFlow(ir([database('db', true)]), current);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].position).toEqual({ x: 412, y: 233 });
  });

  it('takes the parameters from the document, because that is what was accepted', () => {
    const current = { nodes: [placed('db', 0, 0)], edges: [] as Edge[] };

    const { nodes } = applyIrToFlow(ir([database('db', true)]), current);

    expect(nodes[0].data.properties.multiAz).toBe(true);
  });

  it('places a node the patch added rather than dropping it', () => {
    const current = { nodes: [placed('db', 100, 100)], edges: [] as Edge[] };

    const { nodes } = applyIrToFlow(ir([database('db'), bucket('assets')]), current);

    expect(nodes.map((node) => node.id)).toEqual(['db', 'assets']);
    // Clear of the node already on the canvas, so the new one is not hidden
    // underneath something the user was looking at.
    expect(nodes[1].position.x).toBeGreaterThan(100);
  });

  it('drops a node the patch removed', () => {
    const current = { nodes: [placed('db', 0, 0), placed('old', 200, 0)], edges: [] as Edge[] };

    const { nodes } = applyIrToFlow(ir([database('db')]), current);

    expect(nodes.map((node) => node.id)).toEqual(['db']);
  });

  it('keeps no edge pointing at a node that is gone', () => {
    const current = {
      nodes: [placed('db', 0, 0), placed('old', 200, 0)],
      edges: [{ id: 'e1', source: 'old', target: 'db' }] as Edge[],
    };

    const document = ir([database('db')], [
      { id: 'e1', source: 'old', target: 'db', kind: 'connects' },
    ] as ArchitectureIr['edges']);

    expect(applyIrToFlow(document, current).edges).toEqual([]);
  });
});
