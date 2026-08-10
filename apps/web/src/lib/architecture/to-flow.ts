// Turning a proposed architecture into React Flow nodes for the designer canvas.
import type { Edge, Node } from 'reactflow';
import { getServiceById, type ArchitectureProposal, type ProposedNode } from '@infracanvas/core';
import type { ServiceNodeData } from '@/lib/stores/designer-store';

/** Container nodes render behind their children, deepest container in front. */
const Z_INDEX = { vpc: -2, subnet: -1 } as const;

function flowTypeFor(serviceId: string): string {
  if (serviceId === 'vpc-environment') return 'vpcEnvironment';
  if (serviceId === 'public-subnet' || serviceId === 'private-subnet') return 'subnet';
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
    },
  };

  if (proposed.size) {
    Object.assign(node, {
      style: { width: proposed.size.width, height: proposed.size.height },
      width: proposed.size.width,
      height: proposed.size.height,
      zIndex: type === 'vpcEnvironment' ? Z_INDEX.vpc : Z_INDEX.subnet,
    });
  }

  return node;
}

export interface FlowArchitecture {
  nodes: Node<ServiceNodeData>[];
  edges: Edge[];
}

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
      })),
  };
}
