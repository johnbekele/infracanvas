import type {
  AvailabilityNode,
  CostLine,
  IrPatchOp,
  PatchPreview,
  PatchProblem,
  RuleFinding,
} from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

/**
 * The wire shapes of the six tools.
 *
 * Field names are snake_case, which is not this codebase's convention and is
 * deliberate: these are the arguments a language model is shown and the results
 * it reads back, and `020-copilot-tool-surface.md` fixes them so that the MCP
 * server in #118 and any later Python implementation bind to one contract.
 * Renaming a field here is a change to that contract, not a style choice, and
 * the boundary is narrow enough that the inconsistency stays visible.
 *
 * Everything inside the tools - `CopilotDeps`, the store, the preview plane -
 * is ordinary camelCase TypeScript.
 */

/** Ceilings from the spec, so a model cannot ask for an unbounded comparison. */
export const MAX_COMPARE_OPTIONS = 4;
export const MAX_EXPLAIN_EDGES = 40;
export const MAX_OPS_PER_TOOL_CALL = 50;

export interface NodeSummary {
  id: string;
  kind: string;
  name: string;
  parent: string | null;
}

export interface EdgeSummary {
  id: string;
  kind: string;
  source: string;
  target: string;
}

/** A repository path from the stored profile. Never inferred, never constructed. */
export interface FileCitation {
  path: string;
  /** What the path is evidence of, in the profile's own terms. */
  reason: string;
}

/** One tool call the layer served, appended by the layer rather than by the model. */
export interface ToolCall {
  name: string;
  arguments: unknown;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  /** Present when the call failed. The message, never a stack. */
  error?: string;
}

export type ReadArchitectureArgs = Record<string, never>;

export interface ArchitectureView {
  ir: ArchitectureIr;
  ir_digest: string;
  region: string;
  nodes: NodeSummary[];
  edges: EdgeSummary[];
  /** Baseline cost. Null when nothing in the document could be priced. */
  monthly_usd: number | null;
  node_count: number;
}

export interface ExplainNodeArgs {
  node_id: string;
}

export interface NodeExplanation {
  node_id: string;
  kind: string;
  params: Record<string, string | number | boolean | null>;
  /** Nearest first. */
  parent_chain: string[];
  edges_in: EdgeSummary[];
  edges_out: EdgeSummary[];
  cost_lines: CostLine[];
  /**
   * The snapshot every line above was priced from, so a claim about price can
   * be checked against a published list. The cost model carries this per
   * resource rather than per line, and giving a line its own SKU would be a
   * change to `packages/core/src/prediction/`, which this issue excludes.
   */
  price_source: { file: string; priceListVersion: string; capturedAt: string } | null;
  availability: AvailabilityNode | null;
  findings: RuleFinding[];
  evidence: FileCitation[];
}

export interface PriceChangeArgs {
  ops: IrPatchOp[];
}

export interface ProposePatchArgs {
  ops: IrPatchOp[];
  /** One sentence for the diff card. Displayed, never parsed. */
  summary: string;
  /** Why, in the model's own words, shown under the card. */
  rationale: string;
}

export interface PatchProposal {
  /** Null when the patch was refused, because nothing was recorded. */
  proposal_id: string | null;
  patch_digest: string;
  based_on_ir_digest: string;
  /** Whether the patch applies, not whether a user agreed to it. */
  accepted: boolean;
  problems: PatchProblem[];
  preview: PatchPreview | null;
  touched_node_ids: string[];
}

export interface OptionSpec {
  label: string;
  ops: IrPatchOp[];
}

export interface CompareOptionsArgs {
  question: string;
  options: OptionSpec[];
}

export interface ComparedOption {
  label: string;
  accepted: boolean;
  problems: PatchProblem[];
  preview: PatchPreview | null;
}

export interface OptionComparison {
  question: string;
  /** One entry per option, in the order given, including the ones that failed. */
  options: ComparedOption[];
  /** The current architecture, so a comparison always has a do-nothing column. */
  baseline_monthly_usd: number | null;
}

export interface ApplyPatchArgs {
  proposal_id: string;
}

export type ApplyOutcomeKind =
  | 'applied'
  | 'already_applied'
  | 'awaiting_user_acceptance'
  | 'rejected_by_user'
  | 'stale';

export interface ApplyOutcome {
  outcome: ApplyOutcomeKind;
  ir_digest_before: string | null;
  ir_digest_after: string | null;
  touched_node_ids: string[];
  message: string;
}
