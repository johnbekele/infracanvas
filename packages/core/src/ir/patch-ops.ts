import type {
  ArchitectureIr,
  IrEdge,
  IrLayout,
  IrNode,
  ResourceKind,
} from '@infracanvas/ir-schema';

import type { IrParamValue, IrPatchOp, PatchProblem } from './patch';

/**
 * One place where every operation states its precondition, its effect, its
 * inverse and the nodes it touches, so that a second implementation of this
 * protocol - an MCP server, a Python agent - can be checked against a table
 * rather than against prose spread over four call sites.
 */

/** What the IR schema permits inside `params`. */
export type ParamScalar = string | number | boolean;

/**
 * A document mid-patch. `kind` and `params` are deliberately not paired here:
 * `replace_kind` makes a node's parameters wrong for its kind for exactly as
 * long as it takes the next statement to replace them, and intermediate states
 * are legitimately invalid. The pairing is re-established by `validateIr` once,
 * on the finished document.
 */
export interface DraftNode {
  id: string;
  kind: ResourceKind;
  name: string;
  parent?: string | null;
  layout?: IrLayout;
  params: Record<string, ParamScalar>;
}

export interface DraftIr extends Omit<ArchitectureIr, 'nodes'> {
  nodes: DraftNode[];
}

/** A problem an operation has with the document it is being applied to. */
export interface OpProblem {
  pointer: string;
  message: string;
}

export interface OpBehaviour {
  /** Checked against the document as it stands, not against the original. */
  precondition(draft: DraftIr): OpProblem | null;
  /** Computed before `apply`, since an inverse restores what is about to be lost. */
  invert(draft: DraftIr): IrPatchOp;
  touched(draft: DraftIr): string[];
  apply(draft: DraftIr): void;
}

/**
 * The two boundaries where a typed node and a mid-patch node meet. The schema
 * types `params` per kind; a patch names a kind and a parameter at runtime.
 * Confining the conversion to these two functions keeps every other line in
 * this module honest, and `validateIr` is what proves the result.
 */
export function toDraftNode(node: IrNode): DraftNode {
  return node as unknown as DraftNode;
}

export function fromDraftNode(node: DraftNode): IrNode {
  return node as unknown as IrNode;
}

export function toDraft(ir: ArchitectureIr): DraftIr {
  return structuredClone(ir) as unknown as DraftIr;
}

export function fromDraft(draft: DraftIr): ArchitectureIr {
  return draft as unknown as ArchitectureIr;
}

function nodeIndex(draft: DraftIr, id: string): number {
  return draft.nodes.findIndex((node) => node.id === id);
}

function edgeIndex(draft: DraftIr, id: string): number {
  return draft.edges.findIndex((edge) => edge.id === id);
}

function missingNode(id: string): OpProblem {
  return { pointer: '/nodes', message: `names ${id}, which the document does not contain` };
}

/** Drops cleared parameters, since `null` means absent rather than a value of null. */
function withoutNulls(params: Record<string, IrParamValue>): Record<string, ParamScalar> {
  const kept: Record<string, ParamScalar> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) kept[key] = value;
  }
  return kept;
}

function addNode(op: Extract<IrPatchOp, { op: 'add_node' }>): OpBehaviour {
  return {
    precondition(draft) {
      const existing = nodeIndex(draft, op.node.id);
      if (existing >= 0) {
        return {
          pointer: `/nodes/${existing}/id`,
          message: `${op.node.id} is already a node in this document`,
        };
      }
      const parent = op.node.parent;
      if (parent != null && nodeIndex(draft, parent) < 0) {
        return {
          pointer: '/nodes',
          message: `names parent ${parent}, which the document does not contain`,
        };
      }
      return null;
    },
    invert() {
      return { op: 'remove_node', nodeId: op.node.id };
    },
    touched() {
      return [op.node.id];
    },
    apply(draft) {
      draft.nodes.push(structuredClone(toDraftNode(op.node)));
    },
  };
}

function removeNode(op: Extract<IrPatchOp, { op: 'remove_node' }>): OpBehaviour {
  return {
    precondition(draft) {
      const index = nodeIndex(draft, op.nodeId);
      if (index < 0) return missingNode(op.nodeId);

      // Naming the reference rather than cascading: a patch that deletes a
      // database has to name the edges it also deletes, which is what keeps the
      // inverse exact and the blast radius visible on the diff card.
      const edge = draft.edges.find(
        (candidate) => candidate.source === op.nodeId || candidate.target === op.nodeId
      );
      if (edge) {
        return {
          pointer: `/edges/${edgeIndex(draft, edge.id)}`,
          message: `edge ${edge.id} still references ${op.nodeId}; remove it in the same patch first`,
        };
      }

      const child = draft.nodes.find((candidate) => candidate.parent === op.nodeId);
      if (child) {
        return {
          pointer: `/nodes/${nodeIndex(draft, child.id)}/parent`,
          message: `node ${child.id} is still inside ${op.nodeId}; move or remove it in the same patch first`,
        };
      }
      return null;
    },
    invert(draft) {
      const node = draft.nodes[nodeIndex(draft, op.nodeId)];
      return { op: 'add_node', node: fromDraftNode(structuredClone(node)) };
    },
    touched() {
      return [op.nodeId];
    },
    apply(draft) {
      draft.nodes.splice(nodeIndex(draft, op.nodeId), 1);
    },
  };
}

function setParam(op: Extract<IrPatchOp, { op: 'set_param' }>): OpBehaviour {
  return {
    precondition(draft) {
      if (nodeIndex(draft, op.nodeId) < 0) return missingNode(op.nodeId);
      if (typeof op.param !== 'string' || op.param.length === 0) {
        return { pointer: '/nodes', message: 'names an empty parameter' };
      }
      return null;
    },
    invert(draft) {
      const node = draft.nodes[nodeIndex(draft, op.nodeId)];
      const previous = node.params[op.param];
      return {
        op: 'set_param',
        nodeId: op.nodeId,
        param: op.param,
        value: previous === undefined ? null : previous,
      };
    },
    touched() {
      return [op.nodeId];
    },
    apply(draft) {
      const node = draft.nodes[nodeIndex(draft, op.nodeId)];
      if (op.value === null) delete node.params[op.param];
      else node.params[op.param] = op.value;
    },
  };
}

function addEdge(op: Extract<IrPatchOp, { op: 'add_edge' }>): OpBehaviour {
  return {
    precondition(draft) {
      const existing = edgeIndex(draft, op.edge.id);
      if (existing >= 0) {
        return {
          pointer: `/edges/${existing}/id`,
          message: `${op.edge.id} is already an edge in this document`,
        };
      }
      for (const end of ['source', 'target'] as const) {
        if (nodeIndex(draft, op.edge[end]) < 0) {
          return {
            pointer: '/edges',
            message: `names ${end} ${op.edge[end]}, which the document does not contain`,
          };
        }
      }
      return null;
    },
    invert() {
      return { op: 'remove_edge', edgeId: op.edge.id };
    },
    touched() {
      return [op.edge.source, op.edge.target];
    },
    apply(draft) {
      draft.edges.push(structuredClone(op.edge));
    },
  };
}

function removeEdge(op: Extract<IrPatchOp, { op: 'remove_edge' }>): OpBehaviour {
  return {
    precondition(draft) {
      if (edgeIndex(draft, op.edgeId) < 0) {
        return {
          pointer: '/edges',
          message: `names ${op.edgeId}, which the document does not contain`,
        };
      }
      return null;
    },
    invert(draft) {
      const edge: IrEdge = draft.edges[edgeIndex(draft, op.edgeId)];
      return { op: 'add_edge', edge: structuredClone(edge) };
    },
    touched(draft) {
      const edge = draft.edges[edgeIndex(draft, op.edgeId)];
      return edge ? [edge.source, edge.target] : [];
    },
    apply(draft) {
      draft.edges.splice(edgeIndex(draft, op.edgeId), 1);
    },
  };
}

function moveNode(op: Extract<IrPatchOp, { op: 'move_node' }>): OpBehaviour {
  return {
    precondition(draft) {
      const index = nodeIndex(draft, op.nodeId);
      if (index < 0) return missingNode(op.nodeId);
      if (op.parent === null) return null;

      const parentIndex = nodeIndex(draft, op.parent);
      if (parentIndex < 0) {
        return {
          pointer: `/nodes/${index}/parent`,
          message: `names ${op.parent}, which the document does not contain`,
        };
      }

      // Walking rather than recursing, so a cycle a caller proposes cannot
      // exhaust the stack before it is reported.
      const seen = new Set<string>([op.nodeId]);
      let ancestorId: string | null = draft.nodes[parentIndex].id;
      while (ancestorId !== null) {
        if (seen.has(ancestorId)) {
          return {
            pointer: `/nodes/${index}/parent`,
            message: `moving ${op.nodeId} into ${op.parent} would make it its own ancestor`,
          };
        }
        seen.add(ancestorId);
        const ancestor: DraftNode | undefined = draft.nodes[nodeIndex(draft, ancestorId)];
        ancestorId = ancestor?.parent ?? null;
      }
      return null;
    },
    invert(draft) {
      const node = draft.nodes[nodeIndex(draft, op.nodeId)];
      return { op: 'move_node', nodeId: op.nodeId, parent: node.parent ?? null };
    },
    touched() {
      return [op.nodeId];
    },
    apply(draft) {
      const node = draft.nodes[nodeIndex(draft, op.nodeId)];
      // Absent rather than null, matching `normaliseIr`, so that moving a node
      // to the root and back digests identically to never having moved it.
      if (op.parent === null) delete node.parent;
      else node.parent = op.parent;
    },
  };
}

function replaceKind(op: Extract<IrPatchOp, { op: 'replace_kind' }>): OpBehaviour {
  return {
    precondition(draft) {
      const index = nodeIndex(draft, op.nodeId);
      if (index < 0) return missingNode(op.nodeId);
      if (draft.nodes[index].kind === op.kind) {
        return {
          pointer: `/nodes/${index}/kind`,
          message: `${op.nodeId} is already a ${op.kind}`,
        };
      }
      return null;
    },
    invert(draft) {
      const node = draft.nodes[nodeIndex(draft, op.nodeId)];
      return {
        op: 'replace_kind',
        nodeId: op.nodeId,
        kind: node.kind,
        params: structuredClone(node.params),
      };
    },
    touched() {
      return [op.nodeId];
    },
    apply(draft) {
      // `id`, `name`, `parent` and `layout` survive; the parameters do not,
      // because a parameter that means one thing for a queue means nothing for
      // a bucket. Whether the surviving edges still make sense is a question
      // for `validateIr` and the Well-Architected rules, not for this function.
      const node = draft.nodes[nodeIndex(draft, op.nodeId)];
      node.kind = op.kind;
      node.params = withoutNulls(op.params);
    },
  };
}

/** Dispatches to the behaviour for one operation. Unknown operations are rejected before this point. */
export function behaviourFor(op: IrPatchOp): OpBehaviour {
  switch (op.op) {
    case 'add_node':
      return addNode(op);
    case 'remove_node':
      return removeNode(op);
    case 'set_param':
      return setParam(op);
    case 'add_edge':
      return addEdge(op);
    case 'remove_edge':
      return removeEdge(op);
    case 'move_node':
      return moveNode(op);
    case 'replace_kind':
      return replaceKind(op);
  }
}

/**
 * Whether an operation is even shaped like one, checked before any behaviour
 * touches it. A patch arriving from a language model is untrusted input, and a
 * missing field must be a problem the caller can read rather than a
 * `TypeError` from inside a precondition.
 */
export function shapeProblem(op: unknown): Omit<PatchProblem, 'opIndex'> | null {
  const patchProblem = (message: string): Omit<PatchProblem, 'opIndex'> => ({
    pointer: '',
    message,
    source: 'patch',
  });

  if (typeof op !== 'object' || op === null) return patchProblem('is not an operation object');
  const candidate = op as Record<string, unknown>;

  switch (candidate.op) {
    case 'add_node':
      return isNodeShaped(candidate.node) ? null : patchProblem('add_node needs a node with an id');
    case 'remove_node':
    case 'move_node':
    case 'set_param':
      return isId(candidate.nodeId)
        ? null
        : patchProblem(`${String(candidate.op)} needs a node id`);
    case 'add_edge':
      return isEdgeShaped(candidate.edge)
        ? null
        : patchProblem('add_edge needs an edge with an id');
    case 'remove_edge':
      return isId(candidate.edgeId) ? null : patchProblem('remove_edge needs an edge id');
    case 'replace_kind':
      if (!isId(candidate.nodeId)) return patchProblem('replace_kind needs a node id');
      if (typeof candidate.kind !== 'string') {
        return patchProblem('replace_kind needs a resource kind');
      }
      if (typeof candidate.params !== 'object' || candidate.params === null) {
        return patchProblem('replace_kind needs a complete parameter object for the new kind');
      }
      return null;
    default:
      return patchProblem(`${JSON.stringify(candidate.op)} is not a patch operation`);
  }
}

function isId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isNodeShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Partial<DraftNode>;
  return isId(node.id) && typeof node.params === 'object' && node.params !== null;
}

function isEdgeShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const edge = value as Partial<IrEdge>;
  return isId(edge.id) && isId(edge.source) && isId(edge.target);
}
