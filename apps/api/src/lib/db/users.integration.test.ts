import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser, findUserByGitHubId, findUserById, updateUser } from './users.js';

const sampleUser = {
  githubId: 4242,
  githubUsername: 'octocat',
  githubAvatar: 'https://avatars.githubusercontent.com/u/4242',
  email: 'octocat@example.com',
  name: 'The Octocat',
};

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('findOrCreateUser', () => {
  it('creates a user that does not exist yet', async () => {
    const user = await findOrCreateUser(sampleUser);

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.githubId).toBe(4242);
    expect(user.githubUsername).toBe('octocat');
    expect(user.email).toBe('octocat@example.com');
  });

  it('returns the same row on a second call rather than duplicating the account', async () => {
    const first = await findOrCreateUser(sampleUser);
    const second = await findOrCreateUser(sampleUser);

    expect(second.id).toBe(first.id);

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM users');
    expect(rows[0].count).toBe('1');
  });

  it('refreshes the profile when GitHub reports a renamed account', async () => {
    const before = await findOrCreateUser(sampleUser);
    const after = await findOrCreateUser({ ...sampleUser, githubUsername: 'monalisa' });

    expect(after.id).toBe(before.id);
    expect(after.githubUsername).toBe('monalisa');
  });

  it('stores absent optional fields as null instead of the string "undefined"', async () => {
    const user = await findOrCreateUser({
      githubId: 99,
      githubUsername: 'ghost',
      githubAvatar: 'https://example.com/a.png',
    });

    expect(user.email).toBeNull();
    expect(user.name).toBeNull();
  });

  it('survives two concurrent OAuth callbacks for the same account', async () => {
    // Two browser tabs completing the flow at once is the ordinary way this
    // races. The upsert must not raise a unique violation.
    const [a, b] = await Promise.all([findOrCreateUser(sampleUser), findOrCreateUser(sampleUser)]);

    expect(a.id).toBe(b.id);
  });

  it('sets created_at and updated_at', async () => {
    const user = await findOrCreateUser(sampleUser);

    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });
});

describe('findUserById', () => {
  it('finds a user that exists', async () => {
    const created = await findOrCreateUser(sampleUser);
    const found = await findUserById(created.id);

    expect(found?.githubUsername).toBe('octocat');
  });

  it('returns null for an id that matches no row', async () => {
    expect(await findUserById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('findUserByGitHubId', () => {
  it('finds a user by their GitHub id', async () => {
    await findOrCreateUser(sampleUser);
    const found = await findUserByGitHubId(4242);

    expect(found?.githubUsername).toBe('octocat');
  });

  it('returns null for an unknown GitHub id', async () => {
    expect(await findUserByGitHubId(1)).toBeNull();
  });
});

describe('updateUser', () => {
  it('changes only the fields it is given', async () => {
    const created = await findOrCreateUser(sampleUser);
    const updated = await updateUser(created.id, { name: 'Renamed' });

    expect(updated?.name).toBe('Renamed');
    expect(updated?.githubUsername).toBe('octocat');
    expect(updated?.email).toBe('octocat@example.com');
  });

  it('advances updated_at', async () => {
    const created = await findOrCreateUser(sampleUser);
    const updated = await updateUser(created.id, { name: 'Renamed' });

    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('returns null when the user does not exist', async () => {
    const result = await updateUser('00000000-0000-0000-0000-000000000000', { name: 'Nobody' });
    expect(result).toBeNull();
  });
});
