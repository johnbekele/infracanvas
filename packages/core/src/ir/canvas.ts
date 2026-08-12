import {
  validateIr,
  type ArchitectureIr,
  type IrEdge,
  type IrNode,
  type IrProblem,
  type ResourceKind,
} from '@infracanvas/ir-schema';

import { getServiceById } from '../aws-services';
import type { Viewport } from '../types';
import { canvasTypeForNode, serviceIdForNode } from './kind-map';

export type CanvasNodeType =
  | 'service'
  | 'vpc-environment'
  | 'public-subnet'
  | 'private-subnet'
  | 'ecs-cluster';

/** Replaces `ServiceNodeData.properties`. `params` is discriminated by `kind`. */
export interface IrNodeData<K extends ResourceKind = ResourceKind> {
  kind: K;
  name: string;
  params: Extract<IrNode, { kind: K }>['params'];
  /** Presentation resolved from the catalogue rather than stored, so it cannot drift from it. */
  service: {
    serviceId: string;
    serviceName: string;
    shortName: string;
    color: string;
    category: string;
  };
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  /**
   * Relative to `parentNode` when nested, absolute otherwise, as React Flow
   * expects - and the IR stores the same frame. Absolute coordinates in the
   * document would mean dragging a VPC rewrites every descendant, turning one
   * user gesture into a change to every node inside it.
   */
  position: { x: number; y: number };
  parentNode?: string;
  style?: { width: number; height: number };
  data: IrNodeData;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
  data: { kind: IrEdge['kind'] };
}

export interface CanvasGraph {
  /** Parents always precede their children. React Flow drops a child mounted before its parent. */
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  meta: { irVersion: string; name: string; provider: 'aws'; region: string };
}

export class CanvasConversionError extends Error {
  readonly problems: IrProblem[];

  constructor(message: string, problems: IrProblem[]) {
    super(message);
    this.name = 'CanvasConversionError';
    this.problems = problems;
  }
}

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

function presentationFor(node: IrNode): IrNodeData['service'] {
  const serviceId = serviceIdForNode(node);
  const service = serviceId ? getServiceById(serviceId) : undefined;
  if (!serviceId || !service) {
    throw new CanvasConversionError(`The canvas has no shape for the resource kind ${node.kind}.`, [
      {
        pointer: `/nodes/${node.id}/kind`,
        message: `${node.kind} has no catalogue entry, so it cannot be drawn`,
        source: 'reference',
      },
    ]);
  }
  return {
    serviceId,
    serviceName: service.name,
    shortName: service.shortName,
    color: service.color,
    category: service.category,
  };
}

/**
 * Parents before children. React Flow silently drops a child mounted before
 * its parent exists, which shows up as an empty VPC rather than as an error.
 */
function inParentOrder(nodes: IrNode[]): IrNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered: IrNode[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (node: IrNode, trail: string[]): void => {
    const status = state.get(node.id);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new CanvasConversionError(
        `Containment cycle through ${[...trail, node.id].join(' -> ')}.`,
        [
          {
            pointer: `/nodes/${node.id}/parent`,
            message: 'is part of a containment cycle',
            source: 'reference',
          },
        ]
      );
    }

    state.set(node.id, 'visiting');
    const parent = node.parent ? byId.get(node.parent) : undefined;
    if (node.parent && !parent) {
      throw new CanvasConversionError(`Node ${node.id} names a parent no node declares.`, [
        {
          pointer: `/nodes/${node.id}/parent`,
          message: `names ${node.parent}, which no node declares`,
          source: 'reference',
        },
      ]);
    }
    if (parent) visit(parent, [...trail, node.id]);
    state.set(node.id, 'done');
    ordered.push(node);
  };

  // `proposeArchitecture` assembles documents in memory and hands them straight
  // here, so the checks `validateIr` would have made are repeated rather than
  // assumed.
  for (const node of nodes) visit(node, []);
  return ordered;
}

export function irToCanvas(ir: ArchitectureIr): CanvasGraph {
  const nodes = inParentOrder(ir.nodes).map((node): CanvasNode => {
    const canvasNode: CanvasNode = {
      id: node.id,
      type: canvasTypeForNode(node),
      position: { x: node.layout?.x ?? 0, y: node.layout?.y ?? 0 },
      data: {
        kind: node.kind,
        name: node.name,
        params: node.params,
        service: presentationFor(node),
      },
    };
    if (node.parent) canvasNode.parentNode = node.parent;
    if (node.layout?.width !== undefined && node.layout.height !== undefined) {
      canvasNode.style = { width: node.layout.width, height: node.layout.height };
    }
    return canvasNode;
  });

  const edges = ir.edges.map((edge): CanvasEdge => {
    const canvasEdge: CanvasEdge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: { kind: edge.kind },
    };
    if (edge.label !== undefined) canvasEdge.label = edge.label;
    if (edge.sourceHandle !== undefined) canvasEdge.sourceHandle = edge.sourceHandle;
    if (edge.targetHandle !== undefined) canvasEdge.targetHandle = edge.targetHandle;
    return canvasEdge;
  });

  return {
    nodes,
    edges,
    viewport: ir.presentation?.viewport ?? DEFAULT_VIEWPORT,
    meta: {
      irVersion: ir.irVersion,
      name: ir.name,
      provider: ir.provider,
      region: ir.region,
    },
  };
}

/** The cluster synthesised for a service that was drawn without one. */
export function clusterIdFor(serviceNodeId: string): string {
  return `${serviceNodeId}-cluster`;
}

/** Room for one service under a cluster header, before any auto-layout runs. */
const SYNTHESISED_CLUSTER = {
  width: 240,
  height: 160,
  serviceOffset: { x: 20, y: 48 },
} as const;

/**
 * An ECS service needs a cluster, and the canvas lets one be dropped without
 * drawing one. Rather than emit an architecture that cannot deploy, the
 * conversion supplies the cluster the user meant, with an id derived from the
 * service so re-running it produces the same document.
 *
 * It operates on IR nodes rather than canvas nodes so that `normaliseIr` can
 * apply the same rule. Otherwise a document written by hand and the same
 * document after a trip through the canvas would differ by a node, and every
 * round-trip test would be asserting the absence of a rule the product wants.
 */
export function withSynthesisedClusters(nodes: IrNode[]): IrNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hasClusterAncestor = (node: IrNode): boolean => {
    const seen = new Set<string>([node.id]);
    let current = node.parent ? byId.get(node.parent) : undefined;
    while (current && !seen.has(current.id)) {
      if (current.kind === 'ecs_cluster') return true;
      seen.add(current.id);
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    return false;
  };

  const expanded: IrNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'ecs_service' || hasClusterAncestor(node)) {
      expanded.push(node);
      continue;
    }

    const layout = node.layout ?? { x: 0, y: 0 };
    const cluster: IrNode = {
      id: clusterIdFor(node.id),
      kind: 'ecs_cluster',
      name: `${node.name} cluster`,
      ...(node.parent ? { parent: node.parent } : {}),
      layout: {
        x: layout.x,
        y: layout.y,
        width: SYNTHESISED_CLUSTER.width,
        height: SYNTHESISED_CLUSTER.height,
      },
      params: {},
    };

    expanded.push(cluster, {
      ...node,
      parent: cluster.id,
      // The service moved inside the cluster it was given, so its position is
      // now measured from the cluster's origin rather than the subnet's.
      layout: { ...layout, ...SYNTHESISED_CLUSTER.serviceOffset },
    });
  }
  return expanded;
}

/**
 * The cast is discharged immediately: `canvasToIr` validates the assembled
 * document before returning it, so nothing observes an unvalidated node.
 */
function toIrNode(node: CanvasNode): IrNode {
  return {
    id: node.id,
    kind: node.data.kind,
    name: node.data.name,
    ...(node.parentNode !== undefined ? { parent: node.parentNode } : {}),
    // React Flow produces sub-pixel floats while dragging, and storing them
    // makes every drag a document change.
    layout: {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      ...(node.style
        ? { width: Math.round(node.style.width), height: Math.round(node.style.height) }
        : {}),
    },
    params: node.data.params,
  } as IrNode;
}

export function canvasToIr(graph: CanvasGraph): ArchitectureIr {
  const nodes = withSynthesisedClusters(graph.nodes.map(toIrNode));
  const byId = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    if (node.parent && !byId.has(node.parent)) {
      throw new CanvasConversionError(
        `Canvas node ${node.id} is parented to ${node.parent}, which is not on the canvas.`,
        [
          {
            pointer: `/nodes/${node.id}/parent`,
            message: `names ${node.parent}, which no node declares`,
            source: 'reference',
          },
        ]
      );
    }
  }

  const document = {
    irVersion: graph.meta.irVersion,
    name: graph.meta.name,
    provider: graph.meta.provider,
    region: graph.meta.region,
    nodes,
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      kind: edge.data.kind,
      source: edge.source,
      target: edge.target,
      ...(edge.label !== undefined ? { label: edge.label } : {}),
      ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
    })),
    presentation: { viewport: graph.viewport },
  };

  const result = validateIr(document);
  if (!result.valid) {
    throw new CanvasConversionError(
      'The canvas does not describe a valid architecture.',
      result.problems
    );
  }
  return result.document;
}
