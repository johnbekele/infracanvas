/**
 * Which nodes may sit inside which, and where a node actually is.
 *
 * Containment used to be decided only at the moment a service was dropped from
 * the palette: `setNodeParent` existed in the store with no call sites, so a
 * service already on the canvas could never be moved into a VPC. Worse, the
 * hierarchy it produced was ignored by code generation, so a design that looked
 * correctly nested exported Terraform with no subnet references at all. Nesting
 * is a statement about the network, not a visual grouping.
 *
 * Kept out of the canvas component so the rules can be tested without rendering
 * React Flow.
 */
import { PADDING, getServiceById, type ServiceNodeData, type Size } from '@infracanvas/core';
import type { Node } from 'reactflow';

export interface Point {
  x: number;
  y: number;
}

/** Sizes a container falls back to before it has been measured or resized. */
export const CONTAINER_DEFAULT_SIZE: Record<string, Size> = {
  // A zone is drawn around a VPC, so it starts large enough to hold one.
  'availability-zone': { width: 580, height: 520 },
  'vpc-environment': { width: 500, height: 400 },
  'public-subnet': { width: 220, height: 180 },
  'private-subnet': { width: 220, height: 180 },
  'ecs-cluster': { width: 240, height: 200 },
  'eks-cluster': { width: 240, height: 200 },
};

/**
 * Paint order for containers, outermost furthest back.
 *
 * Only the ordering matters, since React Flow gives a child at least its
 * parent's z. It lives here because two places need the same answer: the canvas
 * when a container is dropped, and the store when a saved design is reloaded.
 * They used to hold separate tables, so a reloaded container came back at a
 * depth the canvas would never have given it.
 */
const CONTAINER_Z_INDEX: Record<string, number> = {
  'availability-zone': -4,
  'vpc-environment': -3,
  'public-subnet': -2,
  'private-subnet': -2,
  'ecs-cluster': -1,
  'eks-cluster': -1,
};

export function containerZIndex(serviceId: string): number {
  return CONTAINER_Z_INDEX[serviceId] ?? -1;
}

export const SERVICE_NODE_SIZE: Size = { width: 144, height: 96 };

export function isContainerService(serviceId: string): boolean {
  return getServiceById(serviceId)?.isContainer === true;
}

/** The rendered size of a node, preferring what React Flow measured. */
export function sizeOf(node: Node<ServiceNodeData>): Size {
  const styleWidth = node.style?.width;
  const styleHeight = node.style?.height;

  const width =
    (typeof styleWidth === 'number' ? styleWidth : undefined) ??
    node.width ??
    CONTAINER_DEFAULT_SIZE[node.data.serviceId]?.width ??
    SERVICE_NODE_SIZE.width;

  const height =
    (typeof styleHeight === 'number' ? styleHeight : undefined) ??
    node.height ??
    CONTAINER_DEFAULT_SIZE[node.data.serviceId]?.height ??
    SERVICE_NODE_SIZE.height;

  return { width, height };
}

/** A node's position on the canvas, resolving nesting. */
export function absolutePosition(
  node: Node<ServiceNodeData>,
  nodes: Node<ServiceNodeData>[]
): Point {
  let x = node.position.x;
  let y = node.position.y;
  let current = node;
  const seen = new Set<string>([node.id]);

  while (current.parentNode) {
    const parent = nodes.find((candidate) => candidate.id === current.parentNode);
    // A cycle should be impossible, but a corrupted persisted design would
    // otherwise hang the canvas rather than render slightly wrong.
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    x += parent.position.x;
    y += parent.position.y;
    current = parent;
  }

  return { x, y };
}

/** How deeply a node is nested, used to prefer the innermost container. */
function depthOf(node: Node<ServiceNodeData>, nodes: Node<ServiceNodeData>[]): number {
  let depth = 0;
  let current = node;
  const seen = new Set<string>([node.id]);

  while (current.parentNode) {
    const parent = nodes.find((candidate) => candidate.id === current.parentNode);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }

  return depth;
}

/**
 * The innermost container under a point.
 *
 * Deepest first, so dropping into a subnet inside a VPC lands in the subnet. The
 * node being dragged and everything inside it are excluded, because a container
 * cannot become its own descendant's child.
 */
export function containerAt(
  point: Point,
  nodes: Node<ServiceNodeData>[],
  excludeId?: string
): Node<ServiceNodeData> | null {
  const excluded = excludeId ? descendantIds(excludeId, nodes) : new Set<string>();
  if (excludeId) excluded.add(excludeId);

  const containers = nodes
    .filter((node) => isContainerService(node.data.serviceId) && !excluded.has(node.id))
    .sort((a, b) => depthOf(b, nodes) - depthOf(a, nodes));

  for (const container of containers) {
    const origin = absolutePosition(container, nodes);
    const size = sizeOf(container);

    if (
      point.x >= origin.x &&
      point.x <= origin.x + size.width &&
      point.y >= origin.y &&
      point.y <= origin.y + size.height
    ) {
      return container;
    }
  }

  return null;
}

export function descendantIds(nodeId: string, nodes: Node<ServiceNodeData>[]): Set<string> {
  const found = new Set<string>();
  const queue = [nodeId];

  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const node of nodes) {
      if (node.parentNode === current && !found.has(node.id)) {
        found.add(node.id);
        queue.push(node.id);
      }
    }
  }

  return found;
}

/**
 * Whether a service may be placed inside a container.
 *
 * Rules come from the catalog rather than from a list here, so adding a service
 * does not mean editing this function. `allowedParents` is the explicit form;
 * `subnetPlacement` covers the cases where the constraint is about exposure --
 * a database in a public subnet is reachable from the internet, which is not a
 * layout preference.
 */
export function canNest(serviceId: string, containerServiceId: string | null): boolean {
  const service = getServiceById(serviceId);
  if (!service) return false;

  if (service.parentRequired) return containerServiceId === service.parentRequired;

  if (containerServiceId === null) {
    return !(service.subnetPlacement?.requiresSubnet ?? false);
  }

  if (!isContainerService(containerServiceId)) return false;

  if (service.allowedParents) return service.allowedParents.includes(containerServiceId);

  // A container with no stated parents does not nest. Otherwise an availability
  // zone could be dropped inside a subnet, which describes nothing.
  if (service.isContainer) return false;

  if (containerServiceId === 'public-subnet') {
    return service.subnetPlacement?.allowedInPublic ?? true;
  }
  if (containerServiceId === 'private-subnet') {
    return service.subnetPlacement?.allowedInPrivate ?? true;
  }

  return true;
}

/**
 * A container size large enough for its children.
 *
 * Containers grow and do not shrink: a node dragged out should not snap the box
 * around what is left, because the user usually intends to drag something else
 * back in.
 */
export function grownSize(current: Size, children: { position: Point; size: Size }[]): Size {
  let width = current.width;
  let height = current.height;

  for (const child of children) {
    width = Math.max(width, child.position.x + child.size.width + PADDING.right);
    height = Math.max(height, child.position.y + child.size.height + PADDING.bottom);
  }

  return { width, height };
}

/**
 * Where a node should sit inside a new parent to stay put on screen.
 *
 * A reparent that moves the node is disorienting: the user dragged it to a
 * place, and the only thing that should change is what it belongs to.
 */
export function positionWithin(
  absolute: Point,
  container: Node<ServiceNodeData> | null,
  nodes: Node<ServiceNodeData>[]
): Point {
  if (!container) return absolute;

  const origin = absolutePosition(container, nodes);
  return {
    x: Math.max(PADDING.left / 2, absolute.x - origin.x),
    y: Math.max(PADDING.top / 2, absolute.y - origin.y),
  };
}
