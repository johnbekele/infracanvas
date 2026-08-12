import type { AppProfile, IrPatch, PatchPreview } from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

/**
 * Where the copilot's documents and proposals live.
 *
 * A port rather than a set of queries, for one reason that is not architectural
 * taste: `020-copilot-tool-surface.md` scopes every proposal to a row in
 * `experiments`, and that table belongs to #27, which is still open. The tool
 * contract - the names, the argument and result shapes, and the refusals - is
 * what the epic and the MCP server in #118 bind to, and none of it depends on
 * where the rows are kept. Writing the surface against this interface lets it
 * be finished, tested and reviewed now, and the Postgres adapter is then a file
 * that implements six methods rather than a rewrite of the tools.
 *
 * Two properties the interface, not the adapter, is responsible for:
 *
 * - Every method takes the scope and applies it. There is no method that reads
 *   a proposal by id alone, so no caller can forget the predicate.
 * - `apply` is one operation rather than a read, a compare and a write, because
 *   two accepted proposals racing against one document must not both apply. The
 *   Postgres adapter takes `SELECT ... FOR UPDATE`; the in-memory one takes a
 *   per-experiment lock. Neither leaves the ordering to its callers.
 */

export interface CopilotScope {
  experimentId: string;
  userId: string;
}

export interface ExperimentRecord {
  id: string;
  userId: string;
  name: string;
  ir: ArchitectureIr;
  irDigest: string;
}

export type ProposalStatus = 'proposed' | 'accepted' | 'applied' | 'rejected' | 'superseded';

export interface ProposalRecord {
  id: string;
  experimentId: string;
  userId: string;
  /** `patchDigest()`: identifies the exact bytes the user was shown. */
  patchDigest: string;
  basedOnIrDigest: string;
  patch: IrPatch;
  /** Computed against the document at proposal time, because later it may have moved. */
  inverse: IrPatch;
  /** What the preview plane produced and priced, so applying writes bytes nobody recomputed. */
  patchedIr: ArchitectureIr;
  preview: PatchPreview;
  status: ProposalStatus;
  /** The model's stated reason. Displayed; never parsed. */
  rationale: string;
  appliedIrDigest: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What `insertProposal` is given: the record minus the fields the store owns. */
export type NewProposal = Omit<
  ProposalRecord,
  'id' | 'status' | 'appliedIrDigest' | 'decidedAt' | 'createdAt' | 'updatedAt'
>;

export interface ApplyResult {
  outcome:
    | 'applied'
    | 'already_applied'
    | 'awaiting_user_acceptance'
    | 'rejected_by_user'
    | 'stale';
  irDigestBefore: string | null;
  irDigestAfter: string | null;
  proposal: ProposalRecord;
}

export interface CopilotStore {
  /** Throws `ExperimentNotFoundError` for an unknown id and for another user's, indistinguishably. */
  experiment(scope: CopilotScope): Promise<ExperimentRecord>;

  /** The stored profile behind this experiment's repository, or null when there is none. */
  profile(scope: CopilotScope): Promise<AppProfile | null>;

  /** The open proposal for these exact bytes, so proposing the same edit twice is one proposal. */
  openProposal(scope: CopilotScope, patchDigest: string): Promise<ProposalRecord | null>;

  insertProposal(scope: CopilotScope, proposal: NewProposal): Promise<ProposalRecord>;

  proposal(scope: CopilotScope, proposalId: string): Promise<ProposalRecord | null>;

  /** The user's answer to a diff card. `apply` is what acts on it. */
  decide(
    scope: CopilotScope,
    proposalId: string,
    status: 'accepted' | 'rejected'
  ): Promise<ProposalRecord | null>;

  /**
   * Apply an accepted proposal, atomically with respect to the experiment row.
   *
   * Nothing is recomputed: the document written is the proposal's `patchedIr`,
   * so "what was previewed is what was applied" is a property of the bytes
   * rather than of two implementations agreeing.
   */
  apply(scope: CopilotScope, proposalId: string): Promise<ApplyResult | null>;
}
