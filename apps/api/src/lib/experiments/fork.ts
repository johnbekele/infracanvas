// Forking one experiment's revision into a new experiment.
//
// A fork is the mechanism the product is for: two architectures priced and load
// tested side by side, each with its own history, rather than one document with
// an undo stack. The copy therefore starts a fresh chain at seq 1 whose source is
// `fork`, and records where it came from on the experiment rather than on the
// revision, so a revision's parent is always inside its own experiment.
import type { ArchitectureIr } from '@infracanvas/ir-schema';
import { withTransaction } from '../db/client.js';
import { createExperiment, type Experiment } from '../db/experiments.js';
import {
  appendRevision,
  type ExperimentRevision,
  type IrRevisionSource,
} from '../db/experiment-revisions.js';

export interface ForkInput {
  userId: string;
  /** The experiment being forked, already proven to belong to the caller. */
  source: Experiment;
  /** The revision to fork from, already proven to belong to `source`. */
  sourceRevision: ExperimentRevision;
  name: string;
  hypothesis: string;
  expiresAt: Date;
  budgetUsd: number;
}

export interface SeedInput {
  userId: string;
  repositoryId: string | null;
  name: string;
  hypothesis: string;
  ir: ArchitectureIr;
  irVersion: string;
  summary: string;
  source: IrRevisionSource;
  expiresAt: Date;
  budgetUsd: number;
}

export interface CreatedExperiment {
  experiment: Experiment;
  revision: ExperimentRevision;
}

/**
 * Create an experiment and its first revision in one transaction.
 *
 * Both writes commit together, so no reader ever sees an experiment whose
 * `head_revision_id` is null. That is what the deferred foreign key on
 * `experiments.head_revision_id` exists for: the revision it names cannot be
 * inserted until the experiment does, and the experiment cannot name it until it
 * has been.
 */
export async function createExperimentWithRevision(input: SeedInput): Promise<CreatedExperiment> {
  return withTransaction(async (client) => {
    const experiment = await createExperiment(
      {
        userId: input.userId,
        repositoryId: input.repositoryId,
        name: input.name,
        hypothesis: input.hypothesis,
        expiresAt: input.expiresAt,
        budgetUsd: input.budgetUsd,
      },
      client
    );

    const revision = await appendRevision(
      input.userId,
      {
        experimentId: experiment.id,
        parentId: null,
        ir: input.ir,
        irVersion: input.irVersion,
        summary: input.summary,
        source: input.source,
        authorKind: 'system',
      },
      client
    );

    // Re-read is avoided; the head is the revision that was just appended, and a
    // second SELECT inside the transaction would say the same thing.
    return { experiment: { ...experiment, headRevisionId: revision.id }, revision };
  });
}

/**
 * Fork a revision into a new experiment.
 *
 * The forked chain starts at seq 1 rather than continuing the original's
 * numbering: the new experiment is a separate thing being tested, and a shared
 * sequence would make "revision 4" ambiguous across the two. Lineage is recorded
 * on the experiment as `forked_from_experiment_id` and `forked_from_revision_id`,
 * which is what the header reads to offer a comparison against the origin.
 */
export async function forkExperiment(input: ForkInput): Promise<CreatedExperiment> {
  return withTransaction(async (client) => {
    const experiment = await createExperiment(
      {
        userId: input.userId,
        // Inherited rather than asked for: a fork tests an alternative to the
        // same application, so pointing it at a different repository would make
        // the comparison meaningless.
        repositoryId: input.source.repositoryId,
        name: input.name,
        hypothesis: input.hypothesis,
        expiresAt: input.expiresAt,
        budgetUsd: input.budgetUsd,
        forkedFromExperimentId: input.source.id,
        forkedFromRevisionId: input.sourceRevision.id,
      },
      client
    );

    const revision = await appendRevision(
      input.userId,
      {
        experimentId: experiment.id,
        parentId: null,
        ir: input.sourceRevision.ir,
        irVersion: input.sourceRevision.irVersion,
        summary: `Forked from ${input.source.name} at revision ${input.sourceRevision.seq}`,
        source: 'fork',
        authorKind: 'system',
      },
      client
    );

    return { experiment: { ...experiment, headRevisionId: revision.id }, revision };
  });
}
