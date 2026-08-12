import {
  validateIr,
  type ArchitectureIr,
  type IrEdge,
  type IrNode,
  type ResourceKind,
} from '@infracanvas/ir-schema';

import { irDigest } from './digest';
import { behaviourFor, fromDraft, shapeProblem, toDraft, type DraftIr } from './patch-ops';

/**
 * A change to an architecture, expressed as typed operations rather than as a
 * new document.
 *
 * Two properties follow from that shape and neither follows from a whole-document
 * rewrite. Each operation names the nodes it touches, so a proposal can show its
 * blast radius before anyone accepts it. Each is invertible against the document
 * it applied to, so reverting is `applyPatch(ir, invertPatch(ir, patch))` rather
 * than a snapshot restore that would also revert whatever the user did on the
 * canvas while reading the proposal.
 *
 * Nothing here knows that a language model exists. These are pure functions over
 * two JSON documents with no I/O, no clock and no randomness, which is what
 * makes the property-based round trip in `patch-round-trip.test.ts` meaningful.
 */

export const IR_PATCH_VERSION = 1;

/** A larger edit is a redesign, not a patch, and nobody can review it on a card. */
export const MAX_OPS_PER_PATCH = 50;

/** `null` clears an optional parameter, which is what makes `set_param` invertible both ways. */
export type IrParamValue = string | number | boolean | null;

export type IrPatchOp =
  | { op: 'add_node'; node: IrNode }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'set_param'; nodeId: string; param: string; value: IrParamValue }
  | { op: 'add_edge'; edge: IrEdge }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'move_node'; nodeId: string; parent: string | null }
  | {
      op: 'replace_kind';
      nodeId: string;
      kind: ResourceKind;
      /** Complete parameters for the new kind. The old ones are not merged in. */
      params: Record<string, IrParamValue>;
    };

export interface IrPatch {
  patchVersion: typeof IR_PATCH_VERSION;
  /**
   * `irDigest` of the document this patch was computed against. `applyPatch`
   * refuses any other document, so a proposal cannot land on an architecture
   * that moved underneath it.
   */
  basedOnIrDigest: string;
  /** One sentence, rendered on the diff card. Never read by any decision. */
  summary: string;
  ops: IrPatchOp[];
}

export interface PatchProblem {
  /** Index into `ops`; -1 for a problem with the patch as a whole. */
  opIndex: number;
  /** JSON Pointer into the resulting document, for example `/nodes/3/params/multiAz`. */
  pointer: string;
  message: string;
  /**
   * `patch` for a malformed patch, `precondition` for an operation the document
   * does not permit, `schema` and `reference` as `validateIr` reports them.
   */
  source: 'patch' | 'precondition' | 'schema' | 'reference';
}

export type PatchResult =
  | {
      ok: true;
      ir: ArchitectureIr;
      /** Every node id an operation added, removed, re-parented or edited, deduplicated and sorted. */
      touchedNodeIds: string[];
    }
  | { ok: false; problems: PatchProblem[] };

export class IrPatchError extends Error {
  readonly problems: PatchProblem[];

  constructor(problems: PatchProblem[]) {
    super(`Cannot apply IR patch: ${problems.map((p) => p.message).join('; ')}`);
    this.name = 'IrPatchError';
    this.problems = problems;
  }
}

function wholePatchProblem(message: string): PatchProblem {
  return { opIndex: -1, pointer: '', message, source: 'patch' };
}

/**
 * Everything decidable about a patch before its first operation is read: the
 * version, the operation ceiling, and whether it was computed against this
 * document at all. The digest check comes before any operation is inspected,
 * because a patch aimed at another document has nothing useful to say about
 * this one.
 */
function patchProblems(ir: ArchitectureIr, patch: IrPatch): PatchProblem[] {
  if (typeof patch !== 'object' || patch === null) {
    return [wholePatchProblem('is not a patch object')];
  }
  if (patch.patchVersion !== IR_PATCH_VERSION) {
    return [
      wholePatchProblem(
        `has patch version ${JSON.stringify(patch.patchVersion)}, and this build applies version ${IR_PATCH_VERSION}`
      ),
    ];
  }
  if (!Array.isArray(patch.ops)) return [wholePatchProblem('has no operation list')];

  const digest = irDigest(ir);
  if (patch.basedOnIrDigest !== digest) {
    return [
      wholePatchProblem(
        `was computed against document ${short(patch.basedOnIrDigest)}, and this document is ${short(digest)}`
      ),
    ];
  }

  if (patch.ops.length > MAX_OPS_PER_PATCH) {
    return [
      wholePatchProblem(
        `has ${patch.ops.length} operations, and ${MAX_OPS_PER_PATCH} is the most that can be reviewed on one card`
      ),
    ];
  }

  return [];
}

function short(digest: string): string {
  return typeof digest === 'string' ? digest.slice(0, 12) : JSON.stringify(digest);
}

/**
 * Runs every operation against a working copy, stopping at the first that the
 * document does not permit. Returns the touched ids alongside the draft so a
 * caller can validate once, at the end.
 */
function replay(
  ir: ArchitectureIr,
  ops: IrPatchOp[]
): { draft: DraftIr; touched: string[]; inverses: IrPatchOp[] } | { problems: PatchProblem[] } {
  const draft = toDraft(ir);
  const touched: string[] = [];
  const inverses: IrPatchOp[] = [];

  for (const [index, op] of ops.entries()) {
    const malformed = shapeProblem(op);
    if (malformed) return { problems: [{ opIndex: index, ...malformed }] };

    const behaviour = behaviourFor(op);
    const problem = behaviour.precondition(draft);
    if (problem) {
      return {
        problems: [{ opIndex: index, ...problem, source: 'precondition' }],
      };
    }

    inverses.push(behaviour.invert(draft));
    touched.push(...behaviour.touched(draft));
    behaviour.apply(draft);
  }

  return { draft, touched, inverses };
}

/**
 * Applies every operation in order, then validates once. Never mutates `ir`.
 *
 * Validation runs on the finished document rather than after each operation,
 * because intermediate states are legitimately invalid: removing the edges that
 * point at a node leaves the document referentially fine, and removing the node
 * first does not. A patch is therefore rejected whole rather than partially
 * applied, and the caller gets its input document back untouched.
 */
export function applyPatch(ir: ArchitectureIr, patch: IrPatch): PatchResult {
  const upfront = patchProblems(ir, patch);
  if (upfront.length > 0) return { ok: false, problems: upfront };

  const replayed = replay(ir, patch.ops);
  if ('problems' in replayed) return { ok: false, problems: replayed.problems };

  const validation = validateIr(fromDraft(replayed.draft));
  if (!validation.valid) {
    return {
      ok: false,
      problems: validation.problems.map((problem) => ({
        // The validator judges the finished document, so a problem belongs to
        // the patch rather than to whichever operation happened to touch that
        // pointer last. Guessing an operation index would name the wrong line
        // as often as the right one.
        opIndex: -1,
        pointer: problem.pointer,
        message: problem.message,
        source: problem.source,
      })),
    };
  }

  return {
    ok: true,
    ir: validation.document,
    touchedNodeIds: [...new Set(replayed.touched)].sort(),
  };
}

/**
 * The patch that undoes `patch`, computed against the document it applied to.
 * `basedOnIrDigest` on the result is the digest of the *patched* document.
 *
 * Throws `IrPatchError` when `patch.basedOnIrDigest` does not match `ir`, or
 * when an operation the document does not permit is reached, since an inverse
 * derived from the wrong pre-image is worse than no inverse.
 */
export function invertPatch(ir: ArchitectureIr, patch: IrPatch): IrPatch {
  const upfront = patchProblems(ir, patch);
  if (upfront.length > 0) throw new IrPatchError(upfront);

  const replayed = replay(ir, patch.ops);
  if ('problems' in replayed) throw new IrPatchError(replayed.problems);

  return {
    patchVersion: IR_PATCH_VERSION,
    basedOnIrDigest: irDigest(fromDraft(replayed.draft)),
    summary: patch.summary === '' ? '' : `Reverts: ${patch.summary}`,
    // Last operation first: an inverse has to unwind the sequence in the order
    // that leaves each intermediate document the one its own inverse expects.
    ops: replayed.inverses.reverse(),
  };
}
