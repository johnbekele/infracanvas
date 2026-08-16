// The append-only history of one experiment's architecture.
//
// Every exported function takes `userId` first and folds it into the SQL
// predicate. `experiment_revisions` has no `user_id` column and is not meant to
// grow one: a revision is reached only through its experiment, and the join
// `WHERE r.experiment_id = $1 AND e.user_id = $2` is the single scoping rule
// every read path here carries. There is deliberately no exported function that
// accepts a revision id without an experiment id and a user id.
import type pg from 'pg';
import type { ArchitectureIr } from '@infracanvas/ir-schema';
import { query, withTransaction } from './client.js';
import { computePatch, patchReproduces, type JsonPatchOperation } from './json-patch.js';

export type { JsonPatchOperation } from './json-patch.js';
// Re-exported so a consumer of the revision chain can name the experiment it
// belongs to without importing two modules. Their home is `experiments.ts`.
export type { Experiment, ExperimentVerdict } from './experiments.js';

export type IrRevisionAuthor = 'human' | 'copilot' | 'system';
export type IrRevisionSource =
  | 'proposal'
  | 'canvas_edit'
  | 'copilot_patch'
  | 'fork'
  | 'import'
  | 'revert';

export interface ExperimentRevision {
  id: string;
  experimentId: string;
  seq: number;
  parentId: string | null;
  ir: ArchitectureIr;
  irVersion: string;
  patch: JsonPatchOperation[] | null;
  summary: string;
  source: IrRevisionSource;
  authorKind: IrRevisionAuthor;
  authorUserId: string | null;
  authorAgent: string | null;
  createdAt: Date;
}

/** Everything the timeline draws, with the document left in the database. */
export type RevisionSummary = Omit<ExperimentRevision, 'ir' | 'patch'> & {
  /** Operation count, so the timeline can size a change without reading it. */
  patchOps: number;
};

interface RevisionRow {
  id: string;
  experiment_id: string;
  seq: number;
  parent_id: string | null;
  ir: ArchitectureIr;
  ir_version: string;
  patch: JsonPatchOperation[] | null;
  summary: string;
  source: IrRevisionSource;
  author_kind: IrRevisionAuthor;
  author_user_id: string | null;
  author_agent: string | null;
  created_at: Date;
}

type SummaryRow = Omit<RevisionRow, 'ir' | 'patch'> & { patch_ops: number };

export interface AppendRevisionInput {
  experimentId: string;
  /** Must be the current head. Null only for the first revision of an experiment. */
  parentId: string | null;
  ir: ArchitectureIr;
  irVersion: string;
  /** Computed from parent to child when omitted. Never trusted over `ir`. */
  patch?: JsonPatchOperation[];
  summary: string;
  source: IrRevisionSource;
  authorKind: IrRevisionAuthor;
  authorUserId?: string | null;
  authorAgent?: string | null;
}

/** Raised when `parentId` is not the experiment's head, so the caller can answer 409. */
export class RevisionConflictError extends Error {
  readonly headRevisionId: string | null;
  /**
   * The head's sequence number. Carried alongside the id because the 409 body
   * the REST layer returns names both, and a second query to find the seq of a
   * head we just read under lock would be a round trip for nothing.
   */
  readonly headSeq: number | null;

  constructor(headRevisionId: string | null, headSeq: number | null) {
    super('This experiment has moved on since the revision you edited');
    this.name = 'RevisionConflictError';
    this.headRevisionId = headRevisionId;
    this.headSeq = headSeq;
  }
}

/**
 * Raised when a caller-supplied patch does not take the parent document to the
 * submitted one.
 *
 * Enforced here as well as at the route, so that no path can write a revision
 * whose stored patch disagrees with its stored document. The document is the
 * authority, which only means anything if the derived array is never a lie.
 */
export class PatchMismatchError extends Error {
  constructor() {
    super('The supplied patch does not take the parent document to this one');
    this.name = 'PatchMismatchError';
  }
}

/** Raised when the experiment does not exist or belongs to another user. */
export class ExperimentNotFoundError extends Error {
  constructor() {
    super('Experiment not found');
    this.name = 'ExperimentNotFoundError';
  }
}

function toRevision(row: RevisionRow): ExperimentRevision {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    seq: row.seq,
    parentId: row.parent_id,
    ir: row.ir,
    irVersion: row.ir_version,
    patch: row.patch,
    summary: row.summary,
    source: row.source,
    authorKind: row.author_kind,
    authorUserId: row.author_user_id,
    authorAgent: row.author_agent,
    createdAt: row.created_at,
  };
}

function toSummary(row: SummaryRow): RevisionSummary {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    seq: row.seq,
    parentId: row.parent_id,
    irVersion: row.ir_version,
    summary: row.summary,
    source: row.source,
    authorKind: row.author_kind,
    authorUserId: row.author_user_id,
    authorAgent: row.author_agent,
    createdAt: row.created_at,
    patchOps: Number(row.patch_ops),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The columns the timeline reads. Exported so the test can assert that `ir` is
 * absent from the list itself rather than inferring it from a result size, which
 * would still pass if the column were selected and then discarded in JavaScript.
 */
export const REVISION_SUMMARY_COLUMNS = [
  'r.id',
  'r.experiment_id',
  'r.seq',
  'r.parent_id',
  'r.ir_version',
  'r.summary',
  'r.source',
  'r.author_kind',
  'r.author_user_id',
  'r.author_agent',
  'r.created_at',
  'COALESCE(jsonb_array_length(r.patch), 0) AS patch_ops',
] as const;

/** The pool, or a client already inside a transaction. */
type Executor = Pick<pg.PoolClient, 'query'>;

/**
 * Append one revision and move the head, in a single transaction.
 *
 * `userId` scopes the experiment lookup, so no caller can extend another
 * account's chain by guessing an experiment id.
 *
 * `executor` lets a caller that is already in a transaction -- creating an
 * experiment and its first revision, or forking one -- have both writes commit
 * or roll back together. `experiments.head_revision_id` is a deferred foreign
 * key precisely so that this composition is possible.
 */
export async function appendRevision(
  userId: string,
  input: AppendRevisionInput,
  executor?: Executor
): Promise<ExperimentRevision> {
  if (executor) return appendWith(executor, userId, input);
  return withTransaction((client) => appendWith(client, userId, input));
}

async function appendWith(
  client: Executor,
  userId: string,
  input: AppendRevisionInput
): Promise<ExperimentRevision> {
  if (!UUID_PATTERN.test(input.experimentId)) throw new ExperimentNotFoundError();

  // The experiment row is locked rather than merely read, so two callers
  // appending at once are serialised here: the second sees the head the first
  // installed and raises a conflict, instead of both computing the same seq and
  // one losing to the unique index with an error the caller cannot interpret.
  const current = await client.query<{
    head_revision_id: string | null;
    head_seq: number | null;
    head_ir: ArchitectureIr | null;
  }>(
    `SELECT e.head_revision_id, r.seq AS head_seq, r.ir AS head_ir
       FROM experiments e
       LEFT JOIN experiment_revisions r ON r.id = e.head_revision_id
      WHERE e.id = $1 AND e.user_id = $2
      FOR UPDATE OF e`,
    [input.experimentId, userId]
  );

  const state = current.rows[0];
  if (!state) throw new ExperimentNotFoundError();

  const parentId = input.parentId ?? null;
  if (parentId !== state.head_revision_id) {
    throw new RevisionConflictError(state.head_revision_id, state.head_seq);
  }

  const seq = state.head_seq === null ? 1 : state.head_seq + 1;

  // Null on the first revision, which has no parent to diff against. Otherwise
  // the caller's array is verified rather than believed, and computed when the
  // caller sent none.
  let patch: JsonPatchOperation[] | null = null;
  if (parentId !== null && state.head_ir) {
    const parentIr = state.head_ir as unknown as Record<string, unknown>;
    const childIr = input.ir as unknown as Record<string, unknown>;

    if (input.patch === undefined) {
      patch = computePatch(parentIr, childIr);
    } else {
      if (!patchReproduces(parentIr, input.patch, childIr)) throw new PatchMismatchError();
      patch = input.patch;
    }
  }

  const inserted = await client.query<RevisionRow>(
    `INSERT INTO experiment_revisions
       (experiment_id, seq, parent_id, ir, ir_version, patch, summary,
        source, author_kind, author_user_id, author_agent)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.experimentId,
      seq,
      parentId,
      JSON.stringify(input.ir),
      input.irVersion,
      patch === null ? null : JSON.stringify(patch),
      input.summary,
      input.source,
      input.authorKind,
      input.authorUserId ?? null,
      input.authorAgent ?? null,
    ]
  );

  const row = inserted.rows[0];
  if (!row) throw new Error('Failed to append revision');

  await client.query('UPDATE experiments SET head_revision_id = $2 WHERE id = $1', [
    input.experimentId,
    row.id,
  ]);

  return toRevision(row);
}

export async function findRevision(
  userId: string,
  experimentId: string,
  revisionId: string
): Promise<ExperimentRevision | null> {
  if (!UUID_PATTERN.test(experimentId) || !UUID_PATTERN.test(revisionId)) return null;

  const result = await query<RevisionRow>(
    `SELECT r.* FROM experiment_revisions r
       JOIN experiments e ON e.id = r.experiment_id
      WHERE r.experiment_id = $1 AND r.id = $2 AND e.user_id = $3`,
    [experimentId, revisionId, userId]
  );
  return result.rows[0] ? toRevision(result.rows[0]) : null;
}

/** Newest first. Never selects `ir`; the timeline reads hundreds of these. */
export async function listRevisions(
  userId: string,
  experimentId: string,
  limit = 200
): Promise<RevisionSummary[]> {
  if (!UUID_PATTERN.test(experimentId)) return [];

  const result = await query<SummaryRow>(
    `SELECT ${REVISION_SUMMARY_COLUMNS.join(', ')}
       FROM experiment_revisions r
       JOIN experiments e ON e.id = r.experiment_id
      WHERE r.experiment_id = $1 AND e.user_id = $2
      ORDER BY r.seq DESC
      LIMIT $3`,
    [experimentId, userId, limit]
  );
  return result.rows.map(toSummary);
}

export async function headRevision(
  userId: string,
  experimentId: string
): Promise<ExperimentRevision | null> {
  if (!UUID_PATTERN.test(experimentId)) return null;

  const result = await query<RevisionRow>(
    `SELECT r.* FROM experiment_revisions r
       JOIN experiments e ON e.id = r.experiment_id AND e.head_revision_id = r.id
      WHERE r.experiment_id = $1 AND e.user_id = $2`,
    [experimentId, userId]
  );
  return result.rows[0] ? toRevision(result.rows[0]) : null;
}

/** The two documents a comparison needs, in one round trip and one ownership check. */
export async function findRevisionPair(
  userId: string,
  a: { experimentId: string; revisionId: string },
  b: { experimentId: string; revisionId: string }
): Promise<{ a: ExperimentRevision; b: ExperimentRevision } | null> {
  for (const side of [a, b]) {
    if (!UUID_PATTERN.test(side.experimentId) || !UUID_PATTERN.test(side.revisionId)) return null;
  }

  const result = await query<RevisionRow>(
    `SELECT r.* FROM experiment_revisions r
       JOIN experiments e ON e.id = r.experiment_id
      WHERE e.user_id = $1
        AND ((r.experiment_id = $2 AND r.id = $3) OR (r.experiment_id = $4 AND r.id = $5))`,
    [userId, a.experimentId, a.revisionId, b.experimentId, b.revisionId]
  );

  const found = result.rows.map(toRevision);
  const left = found.find((row) => row.experimentId === a.experimentId && row.id === a.revisionId);
  const right = found.find((row) => row.experimentId === b.experimentId && row.id === b.revisionId);

  // Either side missing means the pair cannot be compared, whether because it
  // does not exist or because it belongs to someone else. The caller cannot tell
  // those apart, which is the point.
  if (!left || !right) return null;
  return { a: left, b: right };
}
