// Analysis runs, the profiles they produce, and the architecture proposed from them.
import type { AppProfile, ArchitectureProposal } from '@infracanvas/core';
import { query } from './client.js';

export type AnalysisStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Analysis {
  id: string;
  repositoryId: string;
  ref: string;
  commitSha: string | null;
  status: AnalysisStatus;
  profile: AppProfile | null;
  /**
   * The architecture synthesised from `profile`, with every decision, its
   * rationale, and the repository paths it was drawn from. Null for a run that
   * failed, and for a run that succeeded before the proposal was stored.
   */
  architecture: ArchitectureProposal | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AnalysisRow {
  id: string;
  repository_id: string;
  ref: string;
  commit_sha: string | null;
  status: AnalysisStatus;
  profile: AppProfile | null;
  architecture: ArchitectureProposal | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toAnalysis(row: AnalysisRow): Analysis {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    ref: row.ref,
    commitSha: row.commit_sha,
    status: row.status,
    profile: row.profile,
    architecture: row.architecture,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Raised when a repository already has an analysis in flight. */
export class AnalysisInProgressError extends Error {
  constructor() {
    super('An analysis is already running for this repository');
    this.name = 'AnalysisInProgressError';
  }
}

/** Postgres 23505: unique violation, raised here by the one-active-run index. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function startAnalysis(repositoryId: string, ref: string): Promise<Analysis> {
  try {
    const result = await query<AnalysisRow>(
      `INSERT INTO analyses (repository_id, ref, status, started_at)
       VALUES ($1, $2, 'running', now())
       RETURNING *`,
      [repositoryId, ref]
    );

    const row = result.rows[0];
    if (!row) throw new Error('Failed to start analysis');
    return toAnalysis(row);
  } catch (error) {
    // Translated rather than surfaced raw, so the caller can answer with a 409
    // without needing to know Postgres error codes.
    if (isUniqueViolation(error)) throw new AnalysisInProgressError();
    throw error;
  }
}

/**
 * Record a successful run, its profile, and the architecture proposed from it.
 *
 * The proposal is written in the same statement as the profile so the two can
 * never disagree about which commit they describe.
 */
export async function completeAnalysis(
  id: string,
  profile: AppProfile,
  architecture: ArchitectureProposal
): Promise<Analysis> {
  const result = await query<AnalysisRow>(
    `UPDATE analyses
        SET status       = 'succeeded',
            profile      = $2,
            architecture = $4,
            commit_sha   = $3,
            finished_at  = now(),
            error        = NULL
      WHERE id = $1
      RETURNING *`,
    [id, JSON.stringify(profile), profile.commitSha, JSON.stringify(architecture)]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Analysis not found');
  return toAnalysis(row);
}

export async function failAnalysis(id: string, message: string): Promise<Analysis> {
  const result = await query<AnalysisRow>(
    `UPDATE analyses
        SET status = 'failed', error = $2, finished_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, message]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Analysis not found');
  return toAnalysis(row);
}

export async function listAnalyses(repositoryId: string, limit = 20): Promise<Analysis[]> {
  const result = await query<AnalysisRow>(
    `SELECT * FROM analyses
      WHERE repository_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [repositoryId, limit]
  );
  return result.rows.map(toAnalysis);
}

export async function findAnalysis(id: string): Promise<Analysis | null> {
  const result = await query<AnalysisRow>('SELECT * FROM analyses WHERE id = $1', [id]);
  return result.rows[0] ? toAnalysis(result.rows[0]) : null;
}

/** The newest successful analysis, which is the one the canvas builds from. */
export async function latestSucceededAnalysis(repositoryId: string): Promise<Analysis | null> {
  const result = await query<AnalysisRow>(
    `SELECT * FROM analyses
      WHERE repository_id = $1 AND status = 'succeeded'
      ORDER BY finished_at DESC
      LIMIT 1`,
    [repositoryId]
  );
  return result.rows[0] ? toAnalysis(result.rows[0]) : null;
}
