// The wire contract for the experiment endpoints.
//
// Kept in one file because the experiment workspace page (#126) is built against
// exactly these shapes: a request body type and the response type it produces
// belong next to each other, so a change to one cannot quietly miss the other.
import type {
  Experiment,
  ExperimentRevision,
  ExperimentVerdict,
  IrRevisionSource,
  JsonPatchOperation,
  RevisionSummary,
} from '../../lib/db/experiment-revisions.js';
import type { IrProblem } from '@infracanvas/ir-schema';

// --- Requests ---------------------------------------------------------------

export interface CreateExperimentBody {
  /**
   * Seeds revision 1 from this repository's newest succeeded analysis. Omit it
   * and send `ir` instead to start from a document the caller already holds.
   */
  repositoryId?: string;
  name: string;
  hypothesis: string;
  /** An explicit starting document, which wins over seeding when both are given. */
  ir?: unknown;
  /** Hours from now. Defaults to `EXPERIMENT_DEFAULT_TTL_HOURS`. */
  ttlHours?: number;
  /** Defaults to `EXPERIMENT_DEFAULT_BUDGET_USD`. */
  budgetUsd?: number;
}

export interface PatchExperimentBody {
  name?: string;
  hypothesis?: string;
  verdict?: ExperimentVerdict;
  /** Required whenever `verdict` is anything other than `undecided`. */
  verdictNote?: string;
  archived?: boolean;
}

export interface ForkExperimentBody {
  /** Defaults to the source experiment's head. */
  revisionId?: string;
  name: string;
  hypothesis: string;
  ttlHours?: number;
  budgetUsd?: number;
}

export interface CreateRevisionBody {
  /**
   * The revision this edit was made against. Must be the current head; a
   * mismatch is a 409 carrying the head, not an overwrite.
   */
  parentId: string;
  /** The whole document, validated before it is accepted. */
  ir: unknown;
  /** Optional. Computed from parent to child when omitted, verified when given. */
  patch?: JsonPatchOperation[];
  /** One line for the timeline, 1 to 200 characters. */
  summary: string;
  source: IrRevisionSource;
  /** The agent behind a copilot edit. Required when the author is the copilot. */
  authorAgent?: string;
}

// --- Responses --------------------------------------------------------------

export interface ExperimentResponse {
  experiment: Experiment;
  /** The head revision, so the page can draw the canvas without a second request. */
  head: ExperimentRevision | null;
  /**
   * Present only on a create that seeded from an analysis: capabilities the
   * profile found that the service catalogue cannot draw yet. Reported rather
   * than dropped, because a missing queue is the difference between an
   * architecture that works and one that looks like it does.
   */
  gaps?: string[];
}

export interface ListExperimentsResponse {
  experiments: Experiment[];
}

export interface RevisionResponse {
  revision: ExperimentRevision;
}

export interface ListRevisionsResponse {
  revisions: RevisionSummary[];
}

/** 400 for a document the IR validator refuses, with the pointers that failed. */
export interface IrRejectedResponse {
  error: string;
  problems: IrProblem[];
}

/**
 * 409 for an append against a parent that is no longer the head.
 *
 * Carries the new head so the page can offer to rebase or discard without
 * another request. The page's conflict handling depends on this shape.
 */
export interface RevisionConflictResponse {
  error: string;
  headRevisionId: string | null;
  headSeq: number | null;
}

export type { Experiment, ExperimentRevision, ExperimentVerdict, RevisionSummary };
