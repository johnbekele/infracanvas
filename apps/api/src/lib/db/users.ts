// User records, keyed by GitHub identity.
import { query } from './client.js';

export interface User {
  id: string;
  githubId: number;
  githubUsername: string;
  githubAvatar: string;
  email: string | null;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  github_id: string;
  github_username: string;
  github_avatar: string;
  email: string | null;
  name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserInput {
  githubId: number;
  githubUsername: string;
  githubAvatar: string;
  email?: string;
  name?: string;
}

/**
 * `bigint` arrives as a string because it can exceed Number.MAX_SAFE_INTEGER.
 * GitHub user IDs are far below that, so narrowing here is safe and keeps the
 * numeric type the rest of the application already expects.
 */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: Number(row.github_id),
    githubUsername: row.github_username,
    githubAvatar: row.github_avatar,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Find or create a user by GitHub ID. Used during OAuth, where two concurrent
 * callbacks for the same account are possible, so this is a single atomic
 * upsert rather than a read followed by a write.
 */
export async function findOrCreateUser(input: CreateUserInput): Promise<User> {
  const result = await query<UserRow>(
    `INSERT INTO users (github_id, github_username, github_avatar, email, name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_id) DO UPDATE
       SET github_username = EXCLUDED.github_username,
           github_avatar   = EXCLUDED.github_avatar,
           email           = EXCLUDED.email,
           name            = EXCLUDED.name
     RETURNING *`,
    [
      input.githubId,
      input.githubUsername,
      input.githubAvatar,
      input.email ?? null,
      input.name ?? null,
    ]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to find or create user');
  return toUser(row);
}

export async function findUserById(userId: string): Promise<User | null> {
  const result = await query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function findUserByGitHubId(githubId: number): Promise<User | null> {
  const result = await query<UserRow>('SELECT * FROM users WHERE github_id = $1', [githubId]);
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export type UserProfileUpdate = Partial<
  Pick<User, 'githubUsername' | 'githubAvatar' | 'email' | 'name'>
>;

/**
 * Update mutable profile fields. `COALESCE` leaves an omitted field untouched,
 * which keeps this a single statement without building SQL by concatenation.
 */
export async function updateUser(userId: string, updates: UserProfileUpdate): Promise<User | null> {
  const result = await query<UserRow>(
    `UPDATE users
        SET github_username = COALESCE($2, github_username),
            github_avatar   = COALESCE($3, github_avatar),
            email           = COALESCE($4, email),
            name            = COALESCE($5, name)
      WHERE id = $1
      RETURNING *`,
    [
      userId,
      updates.githubUsername ?? null,
      updates.githubAvatar ?? null,
      updates.email ?? null,
      updates.name ?? null,
    ]
  );

  return result.rows[0] ? toUser(result.rows[0]) : null;
}
