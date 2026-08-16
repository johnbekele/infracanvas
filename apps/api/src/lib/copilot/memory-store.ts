import { randomUUID } from 'node:crypto';
import { irDigest, type AppProfile } from '@infracanvas/core';
import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { ExperimentNotFoundError } from './errors.js';
import type {
  ApplyResult,
  CopilotScope,
  CopilotStore,
  ExperimentRecord,
  NewProposal,
  ProposalRecord,
} from './store.js';

/**
 * The store the tool suite runs against, and the one a single-process
 * deployment can use before `experiments` exists.
 *
 * It is not a stub: it enforces the same refusals as the Postgres adapter will,
 * including the serialisation `apply` needs. A test that proves two concurrent
 * applies leave one applied proposal is only worth writing if the thing under
 * test actually serialises them, and a per-experiment promise chain is the
 * single-process equivalent of the row lock.
 */

export interface MemoryExperiment {
  id: string;
  userId: string;
  name: string;
  ir: ArchitectureIr;
  profile?: AppProfile | null;
}

export class InMemoryCopilotStore implements CopilotStore {
  private readonly experiments = new Map<string, MemoryExperiment>();
  private readonly proposals = new Map<string, ProposalRecord>();
  /** One tail per experiment: `apply` awaits the previous one before reading. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(experiments: MemoryExperiment[] = []) {
    for (const experiment of experiments) this.experiments.set(experiment.id, experiment);
  }

  /** Test and seed helper. The tools never reach it. */
  put(experiment: MemoryExperiment): void {
    this.experiments.set(experiment.id, experiment);
  }

  private row(scope: CopilotScope): MemoryExperiment {
    const experiment = this.experiments.get(scope.experimentId);
    // One predicate, and one error whatever the reason it missed.
    if (experiment === undefined || experiment.userId !== scope.userId) {
      throw new ExperimentNotFoundError(scope.experimentId);
    }
    return experiment;
  }

  async experiment(scope: CopilotScope): Promise<ExperimentRecord> {
    const row = this.row(scope);
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      ir: row.ir,
      irDigest: irDigest(row.ir),
    };
  }

  async profile(scope: CopilotScope): Promise<AppProfile | null> {
    return this.row(scope).profile ?? null;
  }

  private mine(scope: CopilotScope, proposal: ProposalRecord | undefined): ProposalRecord | null {
    if (proposal === undefined) return null;
    if (proposal.experimentId !== scope.experimentId || proposal.userId !== scope.userId) {
      return null;
    }
    return proposal;
  }

  async openProposal(scope: CopilotScope, patchDigest: string): Promise<ProposalRecord | null> {
    this.row(scope);
    for (const proposal of this.proposals.values()) {
      if (
        proposal.experimentId === scope.experimentId &&
        proposal.patchDigest === patchDigest &&
        proposal.status === 'proposed'
      ) {
        return proposal;
      }
    }
    return null;
  }

  async insertProposal(scope: CopilotScope, proposal: NewProposal): Promise<ProposalRecord> {
    this.row(scope);
    const now = new Date().toISOString();
    const record: ProposalRecord = {
      ...proposal,
      id: randomUUID(),
      status: 'proposed',
      appliedIrDigest: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.set(record.id, record);
    return record;
  }

  async proposal(scope: CopilotScope, proposalId: string): Promise<ProposalRecord | null> {
    this.row(scope);
    return this.mine(scope, this.proposals.get(proposalId));
  }

  async decide(
    scope: CopilotScope,
    proposalId: string,
    status: 'accepted' | 'rejected'
  ): Promise<ProposalRecord | null> {
    this.row(scope);
    const proposal = this.mine(scope, this.proposals.get(proposalId));
    if (proposal === null) return null;
    // Only an open proposal can be decided. Deciding an applied one would let a
    // rejection arrive after the write and claim the document was not changed.
    if (proposal.status !== 'proposed') return proposal;

    const decided: ProposalRecord = {
      ...proposal,
      status,
      decidedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.proposals.set(decided.id, decided);
    return decided;
  }

  async apply(scope: CopilotScope, proposalId: string): Promise<ApplyResult | null> {
    // Queued behind whatever else is applying against this experiment, which is
    // what the Postgres adapter gets from locking the row it is about to write.
    const previous = this.locks.get(scope.experimentId) ?? Promise.resolve();
    const attempt = previous.then(
      () => this.applyLocked(scope, proposalId),
      () => this.applyLocked(scope, proposalId)
    );
    this.locks.set(
      scope.experimentId,
      attempt.catch(() => undefined)
    );
    return attempt;
  }

  private async applyLocked(scope: CopilotScope, proposalId: string): Promise<ApplyResult | null> {
    const experiment = this.row(scope);
    const proposal = this.mine(scope, this.proposals.get(proposalId));
    if (proposal === null) return null;

    const before = irDigest(experiment.ir);

    if (proposal.status === 'applied') {
      return {
        outcome: 'already_applied',
        irDigestBefore: proposal.basedOnIrDigest,
        irDigestAfter: proposal.appliedIrDigest,
        proposal,
      };
    }
    if (proposal.status === 'rejected') {
      return { outcome: 'rejected_by_user', irDigestBefore: before, irDigestAfter: null, proposal };
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

    experiment.ir = proposal.patchedIr;
    const after = irDigest(experiment.ir);
    const applied: ProposalRecord = {
      ...proposal,
      status: 'applied',
      appliedIrDigest: after,
      decidedAt: proposal.decidedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.proposals.set(applied.id, applied);

    return { outcome: 'applied', irDigestBefore: before, irDigestAfter: after, proposal: applied };
  }
}
