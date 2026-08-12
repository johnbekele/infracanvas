// Experiments and the deployments that put them into an AWS account.
//
// `recordDeployment` lives here rather than in a module of its own because a
// deployment is a stage in one experiment's lifecycle and is only ever reached
// through it, which is also how the issue's file list groups them.
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

export interface Experiment {
  id: string;
  userId: string;
  repositoryId: string | null;
  name: string;
  status: ExperimentStatus;
  /**
   * The architecture IR document, held structurally rather than as
   * `ArchitectureIr` because the column carries `{}` for an experiment created
   * before its architecture exists. The append-only revision chain in #123
   * takes this over and drops the column.
   */
  ir: Record<string, unknown>;
  irVersion: string;
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
  ir: Record<string, unknown>;
  ir_version: string;
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
  status?: ExperimentStatus;
  ir?: Record<string, unknown>;
  irVersion: string;
  /** Required rather than defaulted here: the guardrail is the caller's decision. */
  expiresAt: Date;
  budgetUsd: number;
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
    ir: row.ir,
    irVersion: row.ir_version,
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

export async function createExperiment(input: CreateExperimentInput): Promise<Experiment> {
  const result = await query<ExperimentRow>(
    `INSERT INTO experiments
       (user_id, repository_id, name, status, ir, ir_version, expires_at, budget_usd)
     VALUES ($1, $2, $3, COALESCE($4::experiment_status, 'draft'),
             COALESCE($5::jsonb, '{}'::jsonb), $6, $7, $8)
     RETURNING *`,
    [
      input.userId,
      input.repositoryId ?? null,
      input.name,
      input.status ?? null,
      input.ir === undefined ? null : JSON.stringify(input.ir),
      input.irVersion,
      input.expiresAt,
      input.budgetUsd,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to create experiment');
  return toExperiment(row);
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
