// Bookkeeping for engine passes over a repository: walk, parse, chunk, embed.
import { query } from './client.js';

export type IngestionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface IngestionRun {
  id: string;
  repositoryId: string;
  commitSha: string;
  ref: string;
  status: IngestionStatus;
  error: string | null;
  filesTotal: number;
  filesParsed: number;
  chunksWritten: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface IngestionRunRow {
  id: string;
  repository_id: string;
  commit_sha: string;
  ref: string;
  status: IngestionStatus;
  error: string | null;
  files_total: number;
  files_parsed: number;
  chunks_written: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StartRunInput {
  repositoryId: string;
  /** The resolved commit, not the ref it was resolved from. */
  commitSha: string;
  ref: string;
}

export interface RunCounts {
  filesTotal: number;
  filesParsed: number;
  chunksWritten: number;
}

function toIngestionRun(row: IngestionRunRow): IngestionRun {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
    ref: row.ref,
    status: row.status,
    error: row.error,
    filesTotal: row.files_total,
    filesParsed: row.files_parsed,
    chunksWritten: row.chunks_written,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Begin a run, or fail if one is already in flight for the repository.
 *
 * The unique violation from `ingestion_runs_one_active_idx` is deliberately
 * left to propagate rather than being translated into a typed error. The index
 * is the only thing that holds under two concurrent callers, so it is the
 * honest place for the refusal to come from, and there is no HTTP caller yet
 * that would need a friendlier shape.
 */
export async function startIngestionRun(input: StartRunInput): Promise<IngestionRun> {
  const result = await query<IngestionRunRow>(
    `INSERT INTO ingestion_runs (repository_id, commit_sha, ref, status, started_at)
     VALUES ($1, $2, $3, 'running', now())
     RETURNING *`,
    [input.repositoryId, input.commitSha, input.ref]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to start ingestion run');
  return toIngestionRun(row);
}

/**
 * Mark a run finished and record what it produced.
 *
 * `error` is cleared so that a run which recovered after a transient failure
 * does not keep a stale message that contradicts its own success.
 */
export async function completeIngestionRun(
  runId: string,
  counts: RunCounts
): Promise<IngestionRun> {
  const result = await query<IngestionRunRow>(
    `UPDATE ingestion_runs
        SET status         = 'succeeded',
            files_total    = $2,
            files_parsed   = $3,
            chunks_written = $4,
            finished_at    = now(),
            error          = NULL
      WHERE id = $1
      RETURNING *`,
    [runId, counts.filesTotal, counts.filesParsed, counts.chunksWritten]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Ingestion run not found');
  return toIngestionRun(row);
}

/**
 * Record a terminal failure. The counts already written are left alone: knowing
 * a run managed 400 of 900 files before dying is what tells you whether the
 * failure was environmental or specific to one file.
 */
export async function failIngestionRun(runId: string, error: string): Promise<IngestionRun> {
  const result = await query<IngestionRunRow>(
    `UPDATE ingestion_runs
        SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1
      RETURNING *`,
    [runId, error]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Ingestion run not found');
  return toIngestionRun(row);
}

/** The newest complete index, which is the one retrieval should read from. */
export async function latestSucceededRun(repositoryId: string): Promise<IngestionRun | null> {
  const result = await query<IngestionRunRow>(
    `SELECT * FROM ingestion_runs
      WHERE repository_id = $1 AND status = 'succeeded'
      ORDER BY finished_at DESC
      LIMIT 1`,
    [repositoryId]
  );
  return result.rows[0] ? toIngestionRun(result.rows[0]) : null;
}
