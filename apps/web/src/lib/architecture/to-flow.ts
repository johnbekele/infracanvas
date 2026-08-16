// Turning a proposed architecture into React Flow nodes for the designer canvas.
import type { Edge, Node } from 'reactflow';
import { getServiceById, type ArchitectureProposal, type ProposedNode } from '@infracanvas/core';
import type { ServiceNodeData } from '@/lib/stores/designer-store';
import { CONTAINER_DEFAULT_SIZE } from '@/lib/designer/containment';

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

function toFlowNode(proposed: ProposedNode): Node<ServiceNodeData> | null {
  const service = getServiceById(proposed.serviceId);
  // A proposal naming a service the catalog does not have would render as an
  // untitled box, which is worse than leaving it out and keeping the rest.
  if (!service) return null;

  const type = flowTypeFor(proposed.serviceId);

  const node: Node<ServiceNodeData> = {
    id: proposed.id,
    type,
    position: proposed.position,
    // `extent: 'parent'` keeps a node inside the container it was placed in
    // when the user drags it, which is what makes the subnets meaningful.
    ...(proposed.parentId ? { parentNode: proposed.parentId, extent: 'parent' as const } : {}),
    data: {
      serviceId: service.id,
      serviceName: service.name,
      shortName: service.shortName,
      color: service.color,
      category: service.category,
      properties: proposed.properties,
      nodeType: service.isContainer
        ? (service.id as ServiceNodeData['nodeType'])
        : ('service' as const),
      parentId: proposed.parentId,
      // Carried onto the node so the properties panel can show why the engine
      // proposed it. A suggestion a platform engineer cannot check is a
      // suggestion they have no reason to accept.
      evidence: proposed.evidence,
      confidence: proposed.confidence,
      componentPath: proposed.componentPath,
    },
  };

  if (proposed.size) {
    Object.assign(node, {
      style: { width: proposed.size.width, height: proposed.size.height },
      width: proposed.size.width,
      height: proposed.size.height,
      zIndex: Z_INDEX[proposed.serviceId] ?? -1,
    });
  }

  return node;
}

export interface FlowArchitecture {
  nodes: Node<ServiceNodeData>[];
  edges: Edge[];
}

/**
 * An inferred connection is drawn dashed and a declared one solid.
 *
 * A dashed line reads as provisional, which is what an edge derived from
 * capability overlap is: the engine saw that both ends speak the same protocol.
 * A connection the repository wrote down in a compose file is not provisional,
 * and drawing the two identically would invite the user to check work that has
 * already been stated.
 */
const INFERRED_EDGE_STYLE = { strokeDasharray: '6 4' };

export function proposalToFlow(proposal: ArchitectureProposal): FlowArchitecture {
  const nodes = proposal.nodes
    .map(toFlowNode)
    .filter((node): node is Node<ServiceNodeData> => node !== null);

  const placed = new Set(nodes.map((node) => node.id));

  return {
    nodes,
    // An edge to a node that was dropped would leave React Flow with a dangling
    // reference, so edges are filtered to the nodes that actually exist.
    edges: proposal.edges
      .filter((edge) => placed.has(edge.source) && placed.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        type: 'deletable',
        // Carried onto the edge as well as drawn, so anything reading the canvas
        // back can still tell a stated connection from a proposed one.
        data: { origin: edge.origin },
        ...(edge.origin === 'declared' ? {} : { style: INFERRED_EDGE_STYLE }),
      })),
  };
}
