// Folding an architecture document back onto the canvas the user is looking at.
import type { Edge, Node } from 'reactflow';
import {
  getServiceById,
  serviceIdForNode,
  type ArchitectureIr,
  type IrNode,
} from '@infracanvas/core';

import { CONTAINER_DEFAULT_SIZE } from '@/lib/designer/containment';
import { irIdOf } from '@/lib/estimate/to-ir';
import type { ServiceNodeData } from '@/lib/stores/designer-store';

import type { FlowArchitecture } from './to-flow';

/** Container nodes render behind their children, outermost furthest back. */
const Z_INDEX: Record<string, number> = {
  'vpc-environment': -4,
  'availability-zone': -3,
  'public-subnet': -2,
  'private-subnet': -2,
  'ecs-cluster': -1,
  'eks-cluster': -1,
};

function flowTypeFor(serviceId: string): string {
  if (serviceId === 'vpc-environment') return 'vpcEnvironment';
  if (serviceId === 'public-subnet' || serviceId === 'private-subnet') return 'subnet';
  if (serviceId in CONTAINER_DEFAULT_SIZE) return 'cluster';
  return 'serviceNode';
}

/**
 * Where to put a node the document has and the canvas does not.
 *
 * Inside its parent it can go at a fixed offset, because `extent: 'parent'` and
 * the container's own growth will keep it visible. On open canvas it is placed
 * to the right of everything already there, which is not a layout so much as a
 * promise not to drop it on top of an existing node.
 */
function placeNew(
  parentId: string | null,
  existing: Node<ServiceNodeData>[],
  index: number
): { x: number; y: number } {
  if (parentId !== null) return { x: 40, y: 60 + index * 90 };

  const rightEdge = existing
    .filter((node) => node.parentNode === undefined)
    .reduce((furthest, node) => Math.max(furthest, node.position.x + (node.width ?? 160)), 0);

  return { x: rightEdge + 80, y: 80 + index * 110 };
}

function dataFor(node: IrNode, serviceId: string): ServiceNodeData | null {
  const service = getServiceById(serviceId);
  // A kind with no catalogue entry would render as an untitled box, which is
  // worse than leaving it out and keeping the rest of the document.
  if (!service) return null;

  return {
    serviceId: service.id,
    serviceName: service.name,
    shortName: service.shortName,
    color: service.color,
    category: service.category,
    properties: { ...node.params } as ServiceNodeData['properties'],
    nodeType: service.isContainer
      ? (service.id as ServiceNodeData['nodeType'])
      : ('service' as const),
    parentId: node.parent ?? undefined,
  };
}

/**
 * Apply a revision to the canvas, keeping the arrangement the user made.
 *
 * A patch touches two or three nodes out of thirty, and re-deriving the whole
 * layout from the document would move the other twenty-seven for no reason:
 * the user would accept a change to one database and watch their diagram
 * rearrange itself, which reads as the tool having lost their work rather than
 * having made the edit.
 *
 * So position is owned by the canvas and everything else by the document.
 * Nodes present in both keep their coordinates and take the document's
 * parameters, nodes only in the document are placed, and nodes only on the
 * canvas are removed, because the document is what the patch was applied to.
 */
export function applyIrToFlow(
  ir: ArchitectureIr,
  current: { nodes: Node<ServiceNodeData>[]; edges: Edge[] }
): FlowArchitecture {
  // Keyed the way the document spells a canvas id, because that is the mapping
  // the document was built with. Matching on the raw id would find nothing for
  // any node the palette created, and every one of them would be treated as new.
  const byId = new Map(current.nodes.map((node) => [irIdOf(node.id), node]));
  const nodes: Node<ServiceNodeData>[] = [];
  let placed = 0;

  for (const irNode of ir.nodes) {
    const serviceId = serviceIdForNode(irNode);
    if (serviceId === undefined) continue;

    const data = dataFor(irNode, serviceId);
    if (data === null) continue;

    const existing = byId.get(irNode.id);
    const parentNode = irNode.parent ?? undefined;
    const position = existing?.position ?? placeNew(irNode.parent ?? null, current.nodes, placed);
    if (existing === undefined) placed += 1;

    const node: Node<ServiceNodeData> = {
      id: irNode.id,
      type: flowTypeFor(serviceId),
      position,
      ...(parentNode === undefined ? {} : { parentNode, extent: 'parent' as const }),
      data: { ...existing?.data, ...data },
    };

    const size = existing?.width
      ? { width: existing.width, height: existing.height ?? 0 }
      : CONTAINER_DEFAULT_SIZE[serviceId];

    if (size) {
      Object.assign(node, {
        style: { width: size.width, height: size.height },
        width: size.width,
        height: size.height,
        zIndex: Z_INDEX[serviceId] ?? -1,
      });
    }

    nodes.push(node);
  }

  const present = new Set(nodes.map((node) => node.id));
  const styleOf = new Map(current.edges.map((edge) => [irIdOf(edge.id), edge]));

  return {
    nodes,
    edges: ir.edges
      .filter((edge) => present.has(edge.source) && present.has(edge.target))
      .map((edge) => ({
        ...styleOf.get(edge.id),
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'deletable',
      })),
  };
}
