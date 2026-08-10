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
