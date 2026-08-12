// Experiments and the deployments that put them into an AWS account.
//
// `recordDeployment` lives here rather than in a module of its own because a
// deployment is a stage in one experiment's lifecycle and is only ever reached
// through it, which is also how the issue's file list groups them.
import type pg from 'pg';
import { query } from './client.js';

export type ExperimentStatus =
  | 'draft'
  | 'analysing'
  | 'ready'
  | 'deploying'
  | 'deployed'
  | 'testing'
  | 'destroying'
  | 'destroyed'
  | 'failed';

export type ExperimentVerdict = 'undecided' | 'adopt' | 'reject' | 'inconclusive';

export interface Experiment {
  id: string;
  userId: string;
  repositoryId: string | null;
  name: string;
  status: ExperimentStatus;
  /** What this experiment is testing, in the user's words. Never null. */
  hypothesis: string;
  /**
   * The newest revision of this experiment's architecture. Null only between
   * creating the row and appending its first revision, which happen in one
   * transaction, so no reader outside that transaction sees null.
   */
  headRevisionId: string | null;
  forkedFromExperimentId: string | null;
  forkedFromRevisionId: string | null;
  verdict: ExperimentVerdict;
  verdictNote: string | null;
  verdictAt: Date | null;
  archivedAt: Date | null;
  expiresAt: Date;
  budgetUsd: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ExperimentRow {
  id: string;
  user_id: string;
  repository_id: string | null;
  name: string;
  status: ExperimentStatus;
  hypothesis: string;
  head_revision_id: string | null;
  forked_from_experiment_id: string | null;
  forked_from_revision_id: string | null;
  verdict: ExperimentVerdict;
  verdict_note: string | null;
  verdict_at: Date | null;
  archived_at: Date | null;
  expires_at: Date;
  budget_usd: string;
  created_at: Date;
  updated_at: Date;
}

export interface Deployment {
  id: string;
  experimentId: string;
  awsAccountId: string;
  awsRegion: string;
  stackName: string;
  status: string;
  codebuildBuildId: string | null;
  outputs: Record<string, unknown>;
  estimatedMonthlyUsd: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DeploymentRow {
  id: string;
  experiment_id: string;
  aws_account_id: string;
  aws_region: string;
  stack_name: string;
  status: string;
  codebuild_build_id: string | null;
  outputs: Record<string, unknown>;
  estimated_monthly_usd: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateExperimentInput {
  userId: string;
  repositoryId?: string | null;
  name: string;
  /**
   * Required rather than optional: an experiment with no hypothesis is a
   * drawing, and the comparison view has nothing to title its columns with.
   */
  hypothesis: string;
  status?: ExperimentStatus;
  /** Required rather than defaulted here: the guardrail is the caller's decision. */
  expiresAt: Date;
  budgetUsd: number;
  forkedFromExperimentId?: string | null;
  forkedFromRevisionId?: string | null;
}

export interface RecordDeploymentInput {
  experimentId: string;
  awsAccountId: string;
  awsRegion: string;
  stackName: string;
  status: string;
  codebuildBuildId?: string | null;
  outputs?: Record<string, unknown>;
  estimatedMonthlyUsd?: number | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/**
 * `numeric` arrives from pg as a string, because not every value in the type's
 * range survives a float. Budgets and monthly estimates are money in dollars
 * with two decimal places, which is well inside what a Number holds exactly.
 */
function toExperiment(row: ExperimentRow): Experiment {
  return {
    id: row.id,
    userId: row.user_id,
    repositoryId: row.repository_id,
    name: row.name,
    status: row.status,
    hypothesis: row.hypothesis,
    headRevisionId: row.head_revision_id,
    forkedFromExperimentId: row.forked_from_experiment_id,
    forkedFromRevisionId: row.forked_from_revision_id,
    verdict: row.verdict,
    verdictNote: row.verdict_note,
    verdictAt: row.verdict_at,
    archivedAt: row.archived_at,
    expiresAt: row.expires_at,
    budgetUsd: Number(row.budget_usd),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    awsAccountId: row.aws_account_id,
    awsRegion: row.aws_region,
    stackName: row.stack_name,
    status: row.status,
    codebuildBuildId: row.codebuild_build_id,
    outputs: row.outputs,
    estimatedMonthlyUsd:
      row.estimated_monthly_usd === null ? null : Number(row.estimated_monthly_usd),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Ids arrive from URLs, so they are not necessarily uuids. Postgres rejects a
 * malformed one as a query error, which would surface as a server fault for
 * what is really a request for something that cannot exist.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pool, or a client already inside a transaction. */
type Executor = Pick<pg.PoolClient, 'query'>;

/**
 * Create an experiment.
 *
 * `executor` lets the caller create the row and append its first revision in one
 * transaction, so an experiment with no architecture is never visible to anyone
 * else. `experiments.head_revision_id` is a deferred foreign key for exactly
 * this reason: the revision it names cannot exist until the experiment does.
 */
export async function createExperiment(
  input: CreateExperimentInput,
  executor?: Executor
): Promise<Experiment> {
  const run = executor ?? { query };
  const result = await run.query<ExperimentRow>(
    `INSERT INTO experiments
       (user_id, repository_id, name, status, hypothesis, expires_at, budget_usd,
        forked_from_experiment_id, forked_from_revision_id)
     VALUES ($1, $2, $3, COALESCE($4::experiment_status, 'draft'), $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.userId,
      input.repositoryId ?? null,
      input.name,
      input.status ?? null,
      input.hypothesis,
      input.expiresAt,
      input.budgetUsd,
      input.forkedFromExperimentId ?? null,
      input.forkedFromRevisionId ?? null,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to create experiment');
  return toExperiment(row);
}

/**
 * Fetch one experiment belonging to `userId`.
 *
 * The user is part of the lookup rather than checked afterwards, so a caller
 * cannot forget the check and expose another account's experiment by id.
 */
export async function findExperiment(userId: string, id: string): Promise<Experiment | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const result = await query<ExperimentRow>(
    'SELECT * FROM experiments WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0] ? toExperiment(result.rows[0]) : null;
}

/**
 * The caller's experiments, newest first.
 *
 * Archived rows are hidden unless asked for, which is what
 * `experiments_user_repository_idx` is partial on.
 */
export async function listExperiments(
  userId: string,
  filter: { repositoryId?: string; includeArchived?: boolean } = {}
): Promise<Experiment[]> {
  if (filter.repositoryId !== undefined && !UUID_PATTERN.test(filter.repositoryId)) return [];

  const result = await query<ExperimentRow>(
    `SELECT * FROM experiments
      WHERE user_id = $1
        AND ($2::uuid IS NULL OR repository_id = $2::uuid)
        AND ($3::boolean OR archived_at IS NULL)
      ORDER BY created_at DESC`,
    [userId, filter.repositoryId ?? null, filter.includeArchived ?? false]
  );
  return result.rows.map(toExperiment);
}

/**
 * Rename an experiment or restate its hypothesis.
 *
 * Touches neither the revision chain nor the head: what the experiment is called
 * is not part of the architecture it holds.
 */
export async function renameExperiment(
  userId: string,
  id: string,
  fields: { name?: string; hypothesis?: string }
): Promise<Experiment | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const result = await query<ExperimentRow>(
    `UPDATE experiments
        SET name       = COALESCE($3, name),
            hypothesis = COALESCE($4, hypothesis)
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [id, userId, fields.name ?? null, fields.hypothesis ?? null]
  );
  return result.rows[0] ? toExperiment(result.rows[0]) : null;
}

/**
 * Record a verdict, with its reason and the moment it was reached.
 *
 * Note and timestamp are set together because the CHECK refuses a decided
 * verdict without them: a verdict with no reason and no date is a badge rather
 * than a result. Returning to `undecided` clears both for the same reason.
 */
export async function recordVerdict(
  userId: string,
  id: string,
  verdict: ExperimentVerdict,
  note: string
): Promise<Experiment | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const decided = verdict !== 'undecided';
  const result = await query<ExperimentRow>(
    `UPDATE experiments
        SET verdict      = $3,
            verdict_note = CASE WHEN $4::boolean THEN $5 ELSE NULL END,
            verdict_at   = CASE WHEN $4::boolean THEN now() ELSE NULL END
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [id, userId, verdict, decided, note]
  );
  return result.rows[0] ? toExperiment(result.rows[0]) : null;
}

/** Archive or restore an experiment. Archived rows are hidden from the list. */
export async function setExperimentArchived(
  userId: string,
  id: string,
  archived: boolean
): Promise<Experiment | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const result = await query<ExperimentRow>(
    `UPDATE experiments
        SET archived_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [id, userId, archived]
  );
  return result.rows[0] ? toExperiment(result.rows[0]) : null;
}

/** Returns false when the experiment does not exist or belongs to someone else. */
export async function deleteExperiment(userId: string, id: string): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;

  const result = await query('DELETE FROM experiments WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function setExperimentStatus(
  id: string,
  status: ExperimentStatus
): Promise<Experiment> {
  if (!UUID_PATTERN.test(id)) throw new Error('Experiment not found');

  const result = await query<ExperimentRow>(
    'UPDATE experiments SET status = $2 WHERE id = $1 RETURNING *',
    [id, status]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Experiment not found');
  return toExperiment(row);
}

/**
 * Experiments past their expiry that may still be holding AWS resources.
 *
 * The status filter matches `experiments_expiry_idx` exactly so the sweep reads
 * the partial index rather than the table: a draft never provisioned anything,
 * and a destroyed or failed experiment has nothing left to reclaim.
 */
export async function listExpiredExperiments(now: Date): Promise<Experiment[]> {
  const result = await query<ExperimentRow>(
    `SELECT * FROM experiments
      WHERE expires_at < $1
        AND status NOT IN ('destroyed', 'failed', 'draft')
      ORDER BY expires_at ASC`,
    [now]
  );
  return result.rows.map(toExperiment);
}

export async function recordDeployment(input: RecordDeploymentInput): Promise<Deployment> {
  const result = await query<DeploymentRow>(
    `INSERT INTO deployments
       (experiment_id, aws_account_id, aws_region, stack_name, status,
        codebuild_build_id, outputs, estimated_monthly_usd, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb), $8, $9, $10)
     RETURNING *`,
    [
      input.experimentId,
      input.awsAccountId,
      input.awsRegion,
      input.stackName,
      input.status,
      input.codebuildBuildId ?? null,
      input.outputs === undefined ? null : JSON.stringify(input.outputs),
      input.estimatedMonthlyUsd ?? null,
      input.startedAt ?? null,
      input.finishedAt ?? null,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to record deployment');
  return toDeployment(row);
}

export async function listDeployments(experimentId: string): Promise<Deployment[]> {
  if (!UUID_PATTERN.test(experimentId)) return [];

  const result = await query<DeploymentRow>(
    'SELECT * FROM deployments WHERE experiment_id = $1 ORDER BY created_at DESC',
    [experimentId]
  );
  return result.rows.map(toDeployment);
}
