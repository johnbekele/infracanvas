import {
  availability,
  availabilityContext,
  costArchitecture,
  costContext,
  irDigest,
  IR_PATCH_VERSION,
  ruleCoverage,
  type ArchitectureCost,
  type IrPatch,
  type IrPatchOp,
  type PatchPreview,
} from '@infracanvas/core';
import type { ArchitectureIr, IrNode } from '@infracanvas/ir-schema';

import { evidenceForNode } from './evidence.js';
import type { CopilotDeps } from './deps.js';
import {
  MAX_EXPLAIN_EDGES,
  type ApplyOutcome,
  type ApplyPatchArgs,
  type ArchitectureView,
  type CompareOptionsArgs,
  type ComparedOption,
  type EdgeSummary,
  type ExplainNodeArgs,
  type NodeExplanation,
  type OptionComparison,
  type PatchProposal,
  type PriceChangeArgs,
  type ProposePatchArgs,
  type ReadArchitectureArgs,
} from './models.js';

/**
 * The six tools, as plain functions of `(deps, args)`.
 *
 * They are not framework closures. The conversation loop is one caller and the
 * MCP server in #118 is another, and a tool written as a pydantic-ai or
 * tool-calling closure would have to be reimplemented for the second caller,
 * at which point the two disagree about something small and load-bearing -
 * whether `propose_patch` writes, whether a stale document is an error or a
 * warning - with no test able to see the disagreement.
 *
 * Every tool takes its scope from `deps`, never from its arguments. No argument
 * model carries an experiment id, a user id or a credential, so a model cannot
 * reach another user's architecture by guessing a UUID; the store applies the
 * single predicate and answers a miss the same way whatever the reason.
 */

function summaries(ir: ArchitectureIr) {
  return {
    nodes: ir.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      parent: node.parent ?? null,
    })),
    edges: ir.edges.map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      source: edge.source,
      target: edge.target,
    })),
  };
}

/**
 * The monthly figure, or nothing.
 *
 * Null rather than zero when no resource in the document could be priced: a
 * document of unpriced resources is not a free one, and a model shown `0` will
 * say so to a user. A partly priced document does report its total, because the
 * figure is real as far as it goes and `unpriced` says what it omits.
 */
function pricedTotal(cost: ArchitectureCost): number | null {
  const priced = cost.byResource.some((resource) => resource.lines.length > 0);
  return priced ? cost.monthlyUsd : null;
}

/** A patch against the document as it is now, which is what every tool prices. */
function patchFor(ir: ArchitectureIr, ops: IrPatchOp[], summary: string): IrPatch {
  return { patchVersion: IR_PATCH_VERSION, basedOnIrDigest: irDigest(ir), summary, ops };
}

/**
 * The whole document plus an index of it, so a model can name a node without
 * re-reading parameters it does not need.
 */
export async function readArchitecture(
  deps: CopilotDeps,
  _args: ReadArchitectureArgs
): Promise<ArchitectureView> {
  const experiment = await deps.store.experiment(deps.scope);
  const cost = costArchitecture(experiment.ir, costContext(experiment.ir.region));
  const { nodes, edges } = summaries(experiment.ir);

  return {
    ir: experiment.ir,
    ir_digest: experiment.irDigest,
    region: experiment.ir.region,
    nodes,
    edges,
    monthly_usd: pricedTotal(cost.value),
    node_count: experiment.ir.nodes.length,
  };
}

function parentChain(node: IrNode, byId: ReadonlyMap<string, IrNode>): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([node.id]);
  let parentId = node.parent ?? null;

  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    chain.push(parent.id);
    seen.add(parent.id);
    parentId = parent.parent ?? null;
  }
  return chain;
}

export async function explainNode(
  deps: CopilotDeps,
  args: ExplainNodeArgs
): Promise<NodeExplanation> {
  const experiment = await deps.store.experiment(deps.scope);
  const ir = experiment.ir;
  const node = ir.nodes.find((entry) => entry.id === args.node_id);
  if (node === undefined) {
    throw new Error(`No node ${args.node_id} in this architecture`);
  }

  const byId = new Map(ir.nodes.map((entry) => [entry.id, entry]));
  const cost = costArchitecture(ir, costContext(ir.region));
  const reliability = availability(ir, availabilityContext(ir.region));
  const resourceCost = cost.value.byResource.find((entry) => entry.resourceId === node.id) ?? null;

  const edgesIn: EdgeSummary[] = [];
  const edgesOut: EdgeSummary[] = [];
  for (const edge of ir.edges) {
    const summary = { id: edge.id, kind: edge.kind, source: edge.source, target: edge.target };
    // Truncated rather than paginated: a node with more than forty edges is a
    // hub, and the fortieth edge is not what the answer turns on.
    if (edge.target === node.id && edgesIn.length < MAX_EXPLAIN_EDGES) edgesIn.push(summary);
    if (edge.source === node.id && edgesOut.length < MAX_EXPLAIN_EDGES) edgesOut.push(summary);
  }

  return {
    node_id: node.id,
    kind: node.kind,
    params: node.params as Record<string, string | number | boolean | null>,
    parent_chain: parentChain(node, byId),
    edges_in: edgesIn,
    edges_out: edgesOut,
    cost_lines: resourceCost?.lines ?? [],
    price_source: resourceCost?.priceSource ?? null,
    availability: reliability.value.nodes.find((entry) => entry.resourceId === node.id) ?? null,
    findings: ruleCoverage(ir)
      .findings.filter((entry) => entry.resourceId === node.id)
      .map((entry) => entry.finding),
    evidence: evidenceForNode(await deps.store.profile(deps.scope), experiment.name, node.id),
  };
}

/**
 * The delta for a hypothetical, stored nowhere. The cheap tool a model is meant
 * to use while thinking; `propose_patch` is the commitment.
 */
export async function priceChange(deps: CopilotDeps, args: PriceChangeArgs): Promise<PatchPreview> {
  const experiment = await deps.store.experiment(deps.scope);
  const patch = patchFor(experiment.ir, args.ops, 'A change under consideration');
  const result = await deps.preview.preview(experiment.ir, patch);
  return result.preview;
}

/**
 * Two or three ways of meeting one goal, priced against the same document.
 *
 * This is what makes "I want to spend less" or "I will take more latency for a
 * better result" answerable: the options share a baseline, so the numbers can
 * be subtracted from each other rather than merely reported. It records no
 * proposal, because a comparison is a question and a user cannot accept a
 * column.
 */
export async function compareOptions(
  deps: CopilotDeps,
  args: CompareOptionsArgs
): Promise<OptionComparison> {
  const experiment = await deps.store.experiment(deps.scope);
  const cost = costArchitecture(experiment.ir, costContext(experiment.ir.region));

  // Concurrently: the options share one baseline, so the second and later
  // previews are the cheap half of the work, and serialising them would spend
  // the whole comparison inside a single turn's latency budget.
  const options: ComparedOption[] = await Promise.all(
    args.options.map(async (option) => {
      const patch = patchFor(experiment.ir, option.ops, option.label);
      const result = await deps.preview.preview(experiment.ir, patch);
      return {
        label: option.label,
        accepted: result.preview.applicable,
        problems: result.preview.problems,
        preview: result.preview,
      };
    })
  );

  return {
    question: args.question,
    options,
    baseline_monthly_usd: pricedTotal(cost.value),
  };
}

/**
 * Apply the operations in a sandbox, price the result, record the proposal.
 *
 * Writes exactly one row, and nothing to the experiment. A patch that fails
 * validation or a precondition comes back as problems rather than as an
 * exception: the useful next action is for the model to fix the operation order
 * and try again, and an exception per failure mode teaches an agent to stop
 * trying.
 */
export async function proposePatch(
  deps: CopilotDeps,
  args: ProposePatchArgs
): Promise<PatchProposal> {
  const experiment = await deps.store.experiment(deps.scope);
  const patch = patchFor(experiment.ir, args.ops, args.summary);
  const result = await deps.preview.preview(experiment.ir, patch);
  const preview = result.preview;

  if (!preview.applicable || result.patchedIr === null || result.inverse === null) {
    return {
      proposal_id: null,
      patch_digest: preview.patchDigest,
      based_on_ir_digest: preview.basedOnIrDigest,
      accepted: false,
      problems: preview.problems,
      preview,
      touched_node_ids: [],
    };
  }

  // The same edit proposed twice while the first is still open is the same
  // proposal, not two, so a model that repeats itself does not fill a user's
  // card list with duplicates of one decision.
  const open = await deps.store.openProposal(deps.scope, preview.patchDigest);
  const proposal =
    open ??
    (await deps.store.insertProposal(deps.scope, {
      experimentId: deps.scope.experimentId,
      userId: deps.scope.userId,
      patchDigest: preview.patchDigest,
      basedOnIrDigest: preview.basedOnIrDigest,
      patch,
      inverse: result.inverse,
      patchedIr: result.patchedIr,
      preview,
      rationale: args.rationale,
    }));

  return {
    proposal_id: proposal.id,
    patch_digest: preview.patchDigest,
    based_on_ir_digest: preview.basedOnIrDigest,
    accepted: true,
    problems: [],
    preview,
    touched_node_ids: preview.touchedNodeIds,
  };
}

const APPLY_MESSAGES: Record<ApplyOutcome['outcome'], string> = {
  applied: 'The architecture now contains this change.',
  already_applied: 'This proposal was already applied; nothing changed.',
  awaiting_user_acceptance: 'This proposal has not been accepted yet, so nothing was applied.',
  rejected_by_user: 'This proposal was rejected, so nothing was applied.',
  stale: 'The architecture moved since this was priced. Propose the change again.',
};

/**
 * Write the proposal's stored document to the experiment.
 *
 * It takes an id rather than a patch, and the reason is not tidiness: if the
 * argument were a patch document then a model could propose one patch, have it
 * priced and shown, and then apply different bytes, and nothing downstream
 * would notice because both would validate.
 *
 * It refuses a proposal the user has not accepted. The model can hold the tool
 * and still not bypass the person paying for the architecture.
 *
 * Nothing is recomputed. The document written is the one the preview plane
 * produced and priced, so "what was previewed is what was applied" is a
 * property of the bytes rather than of two implementations agreeing.
 */
export async function applyPatch(deps: CopilotDeps, args: ApplyPatchArgs): Promise<ApplyOutcome> {
  await deps.store.experiment(deps.scope);
  const result = await deps.store.apply(deps.scope, args.proposal_id);

  if (result === null) {
    return {
      outcome: 'stale',
      ir_digest_before: null,
      ir_digest_after: null,
      touched_node_ids: [],
      message: 'No such proposal for this architecture.',
    };
  }

  return {
    outcome: result.outcome,
    ir_digest_before: result.irDigestBefore,
    ir_digest_after: result.irDigestAfter,
    touched_node_ids:
      result.outcome === 'applied' || result.outcome === 'already_applied'
        ? result.proposal.preview.touchedNodeIds
        : [],
    message: APPLY_MESSAGES[result.outcome],
  };
}
