import { irDigest, type AppProfile, type IrPatch, type PatchPreview } from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { latestSucceededAnalysis } from '../db/analyses.js';
import { query, withTransaction } from '../db/client.js';
import { appendRevision } from '../db/experiment-revisions.js';
import { ExperimentNotFoundError } from './errors.js';
import type {
  ApplyResult,
  CopilotScope,
  CopilotStore,
  ExperimentRecord,
  NewProposal,
  ProposalRecord,
  ProposalStatus,
} from './store.js';

/**
 * `CopilotStore` over `copilot_proposals`, `experiments` and the revision chain.
 *
 * Two things about it are not incidental.
 *
 * The architecture document is read from the experiment's head revision rather
 * than from the experiment row: `20260812130000_experiment_revisions.sql` moved
 * it there so that the history is a log rather than a chain that has to be
 * replayed. An experiment with no head revision therefore has no architecture,
 * and this adapter answers for it exactly as it answers for one that does not
 * exist -- see `experiment` below.
 *
 * `apply` is a transaction with the experiment row locked, and applying appends
 * to the revision chain inside that same transaction, so the write to the
 * document and the record of who made it commit together or not at all.
 */

interface ProposalRow {
  id: string;
  experiment_id: string;
  user_id: string;
  patch_digest: string;
  based_on_ir_digest: string;
  patch: IrPatch;
  inverse: IrPatch;
  patched_ir: ArchitectureIr;
  preview: PatchPreview;
  status: ProposalStatus;
  rationale: string;
  applied_ir_digest: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A proposal row reached through a LEFT JOIN, where every column may be absent. */
type JoinedProposalRow = { [K in keyof ProposalRow]: ProposalRow[K] | null };

function toProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    userId: row.user_id,
    patchDigest: row.patch_digest,
    basedOnIrDigest: row.based_on_ir_digest,
    patch: row.patch,
    inverse: row.inverse,
    patchedIr: row.patched_ir,
    preview: row.preview,
    status: row.status,
    rationale: row.rationale,
    appliedIrDigest: row.applied_ir_digest,
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Ids arrive from URLs and from model output, so they are not necessarily uuids.
 * Postgres rejects a malformed one as a query error, which would surface as a
 * server fault for what is really a request for something that cannot exist.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres 23505: unique violation, raised here by the open-proposal index. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

const MAX_REVISION_SUMMARY = 200;

/**
 * A revision summary is at most 200 characters by CHECK, and a patch summary is
 * prose written by a model. Truncated rather than rejected: refusing to apply an
 * accepted proposal because its sentence was long would be a failure the user
 * cannot act on.
 */
function revisionSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed === '') return 'Applied a copilot proposal';
  if (trimmed.length <= MAX_REVISION_SUMMARY) return trimmed;
  return `${trimmed.slice(0, MAX_REVISION_SUMMARY - 3)}...`;
}

export class PostgresCopilotStore implements CopilotStore {
  /**
   * The experiment and its current document.
   *
   * The join to the head revision is inner, so an experiment that holds no
   * architecture is reported as missing. The alternative is a second failure
   * mode on a port whose whole error surface is "this is not yours or it is not
   * there", and every caller would have to answer it the same way anyway: there
   * is nothing for a copilot to read, explain or patch.
   */
  async experiment(scope: CopilotScope): Promise<ExperimentRecord> {
    if (!UUID_PATTERN.test(scope.experimentId)) {
      throw new ExperimentNotFoundError(scope.experimentId);
    }

    const result = await query<{ id: string; user_id: string; name: string; ir: ArchitectureIr }>(
      `SELECT e.id, e.user_id, e.name, r.ir
         FROM experiments e
         JOIN experiment_revisions r ON r.id = e.head_revision_id
        WHERE e.id = $1 AND e.user_id = $2`,
      [scope.experimentId, scope.userId]
    );

    const row = result.rows[0];
    if (!row) throw new ExperimentNotFoundError(scope.experimentId);

    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      ir: row.ir,
      irDigest: irDigest(row.ir),
    };
  }

  /**
   * The profile behind this experiment's repository.
   *
   * `latestSucceededAnalysis` is called rather than reimplemented, so "the
   * newest successful analysis" has one definition; the extra round trip buys
   * the scoped lookup that keeps the repository id from being taken on trust.
   */
  async profile(scope: CopilotScope): Promise<AppProfile | null> {
    if (!UUID_PATTERN.test(scope.experimentId)) {
      throw new ExperimentNotFoundError(scope.experimentId);
    }

    const result = await query<{ repository_id: string | null }>(
      'SELECT repository_id FROM experiments WHERE id = $1 AND user_id = $2',
      [scope.experimentId, scope.userId]
    );

    const row = result.rows[0];
    if (!row) throw new ExperimentNotFoundError(scope.experimentId);
    if (row.repository_id === null) return null;

    return (await latestSucceededAnalysis(row.repository_id))?.profile ?? null;
  }

  /**
   * The open proposal for these exact bytes.
   *
   * The LEFT JOIN is what separates "no such proposal" from "no such
   * experiment" in one round trip: no row at all means the experiment is not
   * this user's, and a row whose proposal columns are null means the edit has
   * not been proposed while open.
   */
  async openProposal(scope: CopilotScope, patchDigest: string): Promise<ProposalRecord | null> {
    return this.joined(scope, `AND p.patch_digest = $3 AND p.status = 'proposed'`, patchDigest);
  }

  async proposal(scope: CopilotScope, proposalId: string): Promise<ProposalRecord | null> {
    if (!UUID_PATTERN.test(proposalId)) {
      // Scoped even so: a malformed proposal id must not become a way of
      // learning whether somebody else's experiment exists.
      await this.experiment(scope);
      return null;
    }
    return this.joined(scope, 'AND p.id = $3', proposalId);
  }

  /**
   * One proposal of this experiment's, selected by `predicate`, or null.
   *
   * `predicate` is a literal in this module and `value` is the only input, which
   * is bound. The two proposal reads share this because the interesting half is
   * the LEFT JOIN that tells a missing proposal from a missing experiment, and
   * duplicating it is how one of them would eventually lose the join.
   */
  private async joined(
    scope: CopilotScope,
    predicate: string,
    value: string
  ): Promise<ProposalRecord | null> {
    if (!UUID_PATTERN.test(scope.experimentId)) {
      throw new ExperimentNotFoundError(scope.experimentId);
    }

    const result = await query<JoinedProposalRow>(
      `SELECT p.*
         FROM experiments e
         LEFT JOIN copilot_proposals p
           ON p.experiment_id = e.id AND p.user_id = e.user_id ${predicate}
        WHERE e.id = $1 AND e.user_id = $2`,
      [scope.experimentId, scope.userId, value]
    );

    const row = result.rows[0];
    if (row === undefined) throw new ExperimentNotFoundError(scope.experimentId);
    if (row.id === null) return null;
    return toProposal(row as ProposalRow);
  }

  /**
   * Record a proposal against this experiment.
   *
   * The scope, not the argument, decides which experiment and user the row
   * belongs to: `INSERT ... SELECT` carries the same predicate every read here
   * carries, so a caller cannot write a proposal into an experiment it could not
   * have read.
   */
  async insertProposal(scope: CopilotScope, proposal: NewProposal): Promise<ProposalRecord> {
    if (!UUID_PATTERN.test(scope.experimentId)) {
      throw new ExperimentNotFoundError(scope.experimentId);
    }

    try {
      const result = await query<ProposalRow>(
        `INSERT INTO copilot_proposals
           (experiment_id, user_id, patch_digest, based_on_ir_digest,
            patch, inverse, patched_ir, preview, rationale)
         SELECT e.id, e.user_id, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9
           FROM experiments e
          WHERE e.id = $1 AND e.user_id = $2
         RETURNING *`,
        [
          scope.experimentId,
          scope.userId,
          proposal.patchDigest,
          proposal.basedOnIrDigest,
          JSON.stringify(proposal.patch),
          JSON.stringify(proposal.inverse),
          JSON.stringify(proposal.patchedIr),
          JSON.stringify(proposal.preview),
          proposal.rationale,
        ]
      );

      const row = result.rows[0];
      if (!row) throw new ExperimentNotFoundError(scope.experimentId);
      return toProposal(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Two turns proposed the same bytes at once. The loser reads the winner's
      // row instead of failing: the caller wanted one open proposal for this
      // edit, and that is exactly what it now has.
      const open = await this.openProposal(scope, proposal.patchDigest);
      if (open === null) throw error;
      return open;
    }
  }

  async decide(
    scope: CopilotScope,
    proposalId: string,
    status: 'accepted' | 'rejected'
  ): Promise<ProposalRecord | null> {
    const current = await this.proposal(scope, proposalId);
    if (current === null) return null;
    // Only an open proposal can be decided. Deciding an applied one would let a
    // rejection arrive after the write and claim the document was not changed.
    if (current.status !== 'proposed') return current;

    const result = await query<ProposalRow>(
      `UPDATE copilot_proposals
          SET status = $4::copilot_proposal_status, decided_at = now()
        WHERE id = $3 AND experiment_id = $1 AND user_id = $2 AND status = 'proposed'
        RETURNING *`,
      [scope.experimentId, scope.userId, proposalId, status]
    );

    const row = result.rows[0];
    // Nothing updated means another decision landed between the read and the
    // write. Re-reading reports what actually stands rather than what this call
    // asked for, which is the answer the caller would have got had it arrived a
    // moment later.
    return row ? toProposal(row) : this.proposal(scope, proposalId);
  }

  /**
   * Apply an accepted proposal to the experiment, atomically.
   *
   * The experiment row is locked first and on its own statement. Locking is what
   * serialises two applies -- the second waits here rather than deciding from a
   * document the first is about to replace -- and the separate statement is what
   * makes the wait useful: under READ COMMITTED the next statement in this
   * transaction takes a fresh snapshot, so the document read below is the one
   * the winner committed rather than the one this transaction started with.
   */
  async apply(scope: CopilotScope, proposalId: string): Promise<ApplyResult | null> {
    if (!UUID_PATTERN.test(scope.experimentId)) {
      throw new ExperimentNotFoundError(scope.experimentId);
    }
    if (!UUID_PATTERN.test(proposalId)) {
      await this.experiment(scope);
      return null;
    }

    return withTransaction(async (client) => {
      const locked = await client.query<{ head_revision_id: string | null }>(
        `SELECT head_revision_id FROM experiments
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [scope.experimentId, scope.userId]
      );

      const experiment = locked.rows[0];
      if (!experiment) throw new ExperimentNotFoundError(scope.experimentId);

      const head = await client.query<{ ir: ArchitectureIr }>(
        'SELECT ir FROM experiment_revisions WHERE id = $1',
        [experiment.head_revision_id]
      );
      const currentIr = head.rows[0]?.ir;
      if (currentIr === undefined || experiment.head_revision_id === null) {
        throw new ExperimentNotFoundError(scope.experimentId);
      }

      // Locked as well, so a decision cannot land between this read and the
      // write below and leave an applied proposal that says it was rejected.
      const found = await client.query<ProposalRow>(
        `SELECT * FROM copilot_proposals
          WHERE id = $1 AND experiment_id = $2 AND user_id = $3
          FOR UPDATE`,
        [proposalId, scope.experimentId, scope.userId]
      );
      if (!found.rows[0]) return null;

      const proposal = toProposal(found.rows[0]);
      const before = irDigest(currentIr);

      if (proposal.status === 'applied') {
        return {
          outcome: 'already_applied',
          irDigestBefore: proposal.basedOnIrDigest,
          irDigestAfter: proposal.appliedIrDigest,
          proposal,
        };
      }
      if (proposal.status === 'rejected') {
        return {
          outcome: 'rejected_by_user',
          irDigestBefore: before,
          irDigestAfter: null,
          proposal,
        };
      }
      if (proposal.status !== 'accepted') {
        return {
          outcome: 'awaiting_user_acceptance',
          irDigestBefore: before,
          irDigestAfter: null,
          proposal,
        };
      }
      if (proposal.basedOnIrDigest !== before) {
        return { outcome: 'stale', irDigestBefore: before, irDigestAfter: null, proposal };
      }

      // The stored document, byte for byte, and no recomputation of it. The
      // revision is appended with this transaction's client so the new document
      // and the applied proposal commit together; `appendRevision` re-locks the
      // experiment row this transaction already holds, which costs nothing.
      await appendRevision(
        scope.userId,
        {
          experimentId: scope.experimentId,
          parentId: experiment.head_revision_id,
          ir: proposal.patchedIr,
          irVersion: proposal.patchedIr.irVersion,
          summary: revisionSummary(proposal.patch.summary),
          // A human accepting a copilot suggestion is a human-authored
          // copilot_patch, which is the distinction `author_kind` exists for.
          source: 'copilot_patch',
          authorKind: 'human',
          authorUserId: scope.userId,
        },
        client
      );

      const after = irDigest(proposal.patchedIr);
      const applied = await client.query<ProposalRow>(
        `UPDATE copilot_proposals
            SET status = 'applied',
                applied_ir_digest = $4,
                decided_at = COALESCE(decided_at, now())
          WHERE id = $3 AND experiment_id = $1 AND user_id = $2
          RETURNING *`,
        [scope.experimentId, scope.userId, proposalId, after]
      );

      const row = applied.rows[0];
      if (!row) throw new Error('Failed to record an applied proposal');

      return {
        outcome: 'applied',
        irDigestBefore: before,
        irDigestAfter: after,
        proposal: toProposal(row),
      };
    });
  }
}
