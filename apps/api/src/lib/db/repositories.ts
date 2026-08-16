// Repositories a user has connected for analysis.
import { query } from './client.js';

export interface Repository {
  id: string;
  userId: string;
  githubId: number;
  githubOwner: string;
  githubName: string;
  defaultBranch: string;
  isPrivate: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface RepositoryRow {
  id: string;
  user_id: string;
  github_id: string;
  github_owner: string;
  github_name: string;
  default_branch: string;
  is_private: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ConnectRepositoryInput {
  userId: string;
  githubId: number;
  githubOwner: string;
  githubName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

/** `bigint` arrives as a string; GitHub repository ids are well inside Number's safe range. */
function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    userId: row.user_id,
    githubId: Number(row.github_id),
    githubOwner: row.github_owner,
    githubName: row.github_name,
    defaultBranch: row.default_branch,
    isPrivate: row.is_private,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Connect a repository, or refresh the details of one already connected.
 *
 * An upsert rather than an insert because connecting the same repository twice
 * is an ordinary thing for a user to do -- they return to the picker and choose
 * it again -- and it should be idempotent rather than an error they have to
 * read. It also keeps `default_branch` and `is_private` current when they have
 * changed on GitHub since the last connection.
 */
export async function connectRepository(input: ConnectRepositoryInput): Promise<Repository> {
  const result = await query<RepositoryRow>(
    `INSERT INTO repositories (user_id, github_id, github_owner, github_name, default_branch, is_private)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, github_owner, github_name) DO UPDATE
       SET github_id      = EXCLUDED.github_id,
           default_branch = EXCLUDED.default_branch,
           is_private     = EXCLUDED.is_private
     RETURNING *`,
    [
      input.userId,
      input.githubId,
      input.githubOwner,
      input.githubName,
      input.defaultBranch,
      input.isPrivate,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to connect repository');
  return toRepository(row);
}

export async function listRepositories(userId: string): Promise<Repository[]> {
  const result = await query<RepositoryRow>(
    'SELECT * FROM repositories WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return result.rows.map(toRepository);
}

/**
 * What each connected repository is currently showing: its newest run whatever
 * the outcome, and its newest proposal, which are not always the same run.
 *
 * One query with two lateral joins rather than a request per card. A list page
 * that fires a query per row is the reason lists feel slow, and the figures on
 * these cards are the whole point of the page: a repository with no state to
 * report is indistinguishable from one nobody has looked at.
 */
export interface RepositoryWithState extends Repository {
  latest: LatestRun | null;
  /** The newest run that produced a profile. A later failure must not erase it. */
  succeeded: LatestRun | null;
}

export interface LatestRun {
  id: string;
  ref: string;
  status: string;
  commitSha: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** Present only on `succeeded`, and only once a proposal has been stored. */
  architecture: unknown | null;
}

interface RunColumns {
  latest_id: string | null;
  latest_ref: string | null;
  latest_status: string | null;
  latest_commit_sha: string | null;
  latest_error: string | null;
  latest_created_at: Date | null;
  latest_finished_at: Date | null;
  succeeded_id: string | null;
  succeeded_ref: string | null;
  succeeded_commit_sha: string | null;
  succeeded_created_at: Date | null;
  succeeded_finished_at: Date | null;
  succeeded_architecture: unknown | null;
}

export async function listRepositoriesWithState(userId: string): Promise<RepositoryWithState[]> {
  const result = await query<RepositoryRow & RunColumns>(
    `SELECT r.*,
            latest.id           AS latest_id,
            latest.ref          AS latest_ref,
            latest.status       AS latest_status,
            latest.commit_sha   AS latest_commit_sha,
            latest.error        AS latest_error,
            latest.created_at   AS latest_created_at,
            latest.finished_at  AS latest_finished_at,
            ok.id               AS succeeded_id,
            ok.ref              AS succeeded_ref,
            ok.commit_sha       AS succeeded_commit_sha,
            ok.created_at       AS succeeded_created_at,
            ok.finished_at      AS succeeded_finished_at,
            ok.architecture     AS succeeded_architecture
       FROM repositories r
       LEFT JOIN LATERAL (
         SELECT * FROM analyses a
          WHERE a.repository_id = r.id
          ORDER BY a.created_at DESC
          LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT * FROM analyses a
          WHERE a.repository_id = r.id AND a.status = 'succeeded'
          ORDER BY a.created_at DESC
          LIMIT 1
       ) ok ON true
      WHERE r.user_id = $1
      ORDER BY COALESCE(latest.created_at, r.created_at) DESC`,
    [userId]
  );

  return result.rows.map((row) => ({
    ...toRepository(row),
    latest:
      row.latest_id === null
        ? null
        : {
            id: row.latest_id,
            ref: row.latest_ref ?? '',
            status: row.latest_status ?? 'pending',
            commitSha: row.latest_commit_sha,
            error: row.latest_error,
            createdAt: row.latest_created_at ?? row.created_at,
            finishedAt: row.latest_finished_at,
            architecture: null,
          },
    succeeded:
      row.succeeded_id === null
        ? null
        : {
            id: row.succeeded_id,
            ref: row.succeeded_ref ?? '',
            status: 'succeeded',
            commitSha: row.succeeded_commit_sha,
            error: null,
            createdAt: row.succeeded_created_at ?? row.created_at,
            finishedAt: row.succeeded_finished_at,
            architecture: row.succeeded_architecture,
          },
  }));
}

/**
 * Ids arrive from URLs, so they are not necessarily uuids. Postgres rejects a
 * malformed one as a query error, which would surface as a server fault for
 * what is really just a request for something that cannot exist. Checking the
 * shape first turns that into an ordinary "not found".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch one repository belonging to `userId`.
 *
 * The user is part of the lookup rather than checked afterwards, so a caller
 * cannot forget the check and expose another account's repository by id.
 */
export async function findRepository(userId: string, id: string): Promise<Repository | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const result = await query<RepositoryRow>(
    'SELECT * FROM repositories WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return result.rows[0] ? toRepository(result.rows[0]) : null;
}

/** Returns false when the repository does not exist or belongs to someone else. */
export async function disconnectRepository(userId: string, id: string): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;

  const result = await query('DELETE FROM repositories WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}
