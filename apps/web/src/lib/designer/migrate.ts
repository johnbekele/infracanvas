/**
 * Bringing a saved design in line with the current containment rules.
 *
 * The rules change as the catalog learns what a construct really is -- an
 * availability zone was drawn inside a VPC before it became the box the VPC
 * sits in -- and a design saved under the old rules would otherwise reopen
 * showing nesting the editor can no longer produce. Wiping the design would be
 * the cheap answer; detaching the node that no longer fits keeps the work.
 */
import type { Node } from 'reactflow';
import type { ServiceNodeData } from '@infracanvas/core';
import { absolutePosition, canNest } from './containment';

/** Nodes with any parent link the rules no longer allow removed. */
export function detachIllegalParents(nodes: Node<ServiceNodeData>[]): Node<ServiceNodeData>[] {
  return nodes.map((node) => {
    if (!node.parentNode) return node;

    // A parent that is gone counts as one the node cannot have, so no caller has
    // to remember to clear dangling links before asking about the rules.
    const parent = nodes.find((candidate) => candidate.id === node.parentNode);
    if (parent && canNest(node.data.serviceId, parent.data.serviceId)) return node;

    // Absolute position, so the node stays where it was drawn instead of
    // reappearing at the old parent's offset from the canvas origin.
    return {
      ...node,
      position: absolutePosition(node, nodes),
      parentNode: undefined,
      extent: undefined,
      data: { ...node.data, parentId: undefined },
    };
  });
}
