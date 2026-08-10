import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import {
  connectRepository,
  disconnectRepository,
  findRepository,
  listRepositories,
} from './repositories.js';

async function makeUser(githubId: number, username: string) {
  return findOrCreateUser({
    githubId,
    githubUsername: username,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });
}

const sampleRepo = {
  githubId: 987_654,
  githubOwner: 'octocat',
  githubName: 'hello-world',
  defaultBranch: 'main',
  isPrivate: false,
};

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('connectRepository', () => {
  it('records a repository against the user who connected it', async () => {
    const user = await makeUser(1, 'octocat');

    const repository = await connectRepository({ userId: user.id, ...sampleRepo });

    expect(repository.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(repository.githubOwner).toBe('octocat');
    expect(repository.githubName).toBe('hello-world');
    expect(repository.defaultBranch).toBe('main');
    expect(repository.isPrivate).toBe(false);
  });

  it('upserts rather than duplicating when the same repository is connected twice', async () => {
    // Returning to the picker and choosing the same repository again is an
    // ordinary thing to do, and should not be an error the user has to read.
    const user = await makeUser(1, 'octocat');

    const first = await connectRepository({ userId: user.id, ...sampleRepo });
    const second = await connectRepository({ userId: user.id, ...sampleRepo });

    expect(second.id).toBe(first.id);

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM repositories');
    expect(rows[0].count).toBe('1');
  });

  it('refreshes details that have changed on GitHub since the last connection', async () => {
    const user = await makeUser(1, 'octocat');
    await connectRepository({ userId: user.id, ...sampleRepo });

    const updated = await connectRepository({
      ...sampleRepo,
      userId: user.id,
      defaultBranch: 'trunk',
      isPrivate: true,
    });

    expect(updated.defaultBranch).toBe('trunk');
    expect(updated.isPrivate).toBe(true);
  });

  it('lets two users each connect the same public repository', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');

    const hers = await connectRepository({ userId: alice.id, ...sampleRepo });
    const his = await connectRepository({ userId: bob.id, ...sampleRepo });

    // The uniqueness constraint is scoped to the user; a global one would mean
    // whoever connected a popular repository first locked everyone else out.
    expect(his.id).not.toBe(hers.id);
    expect(await listRepositories(alice.id)).toHaveLength(1);
    expect(await listRepositories(bob.id)).toHaveLength(1);
  });
});

describe('listRepositories', () => {
  it('returns only the requesting user\u2019s repositories', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');

    await connectRepository({ userId: alice.id, ...sampleRepo });
    await connectRepository({
      ...sampleRepo,
      userId: bob.id,
      githubName: 'bobs-project',
      githubId: 111,
    });

    const hers = await listRepositories(alice.id);

    expect(hers).toHaveLength(1);
    expect(hers[0].githubName).toBe('hello-world');
  });

  it('returns the most recently connected repository first', async () => {
    const user = await makeUser(1, 'octocat');

    await connectRepository({ userId: user.id, ...sampleRepo });
    await connectRepository({
      ...sampleRepo,
      userId: user.id,
      githubName: 'second-repo',
      githubId: 222,
    });

    const repositories = await listRepositories(user.id);

    expect(repositories.map((r) => r.githubName)).toEqual(['second-repo', 'hello-world']);
  });

  it('returns an empty list for a user with nothing connected', async () => {
    const user = await makeUser(1, 'octocat');
    expect(await listRepositories(user.id)).toEqual([]);
  });
});

describe('findRepository', () => {
  it('finds a repository belonging to the user', async () => {
    const user = await makeUser(1, 'octocat');
    const connected = await connectRepository({ userId: user.id, ...sampleRepo });

    const found = await findRepository(user.id, connected.id);

    expect(found?.id).toBe(connected.id);
  });

  it('does not return a repository belonging to another user', async () => {
    // The owner is part of the lookup rather than a check afterwards, so a
    // caller cannot forget it and expose someone else's repository by id.
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await connectRepository({ userId: alice.id, ...sampleRepo });

    expect(await findRepository(bob.id, hers.id)).toBeNull();
  });
});

describe('disconnectRepository', () => {
  it('removes the repository and reports that it did', async () => {
    const user = await makeUser(1, 'octocat');
    const connected = await connectRepository({ userId: user.id, ...sampleRepo });

    expect(await disconnectRepository(user.id, connected.id)).toBe(true);
    expect(await listRepositories(user.id)).toEqual([]);
  });

  it('refuses to remove a repository belonging to another user', async () => {
    const alice = await makeUser(1, 'alice');
    const bob = await makeUser(2, 'bob');
    const hers = await connectRepository({ userId: alice.id, ...sampleRepo });

    expect(await disconnectRepository(bob.id, hers.id)).toBe(false);
    expect(await listRepositories(alice.id)).toHaveLength(1);
  });

  it('reports false for a repository that does not exist', async () => {
    const user = await makeUser(1, 'octocat');
    expect(await disconnectRepository(user.id, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('cascading deletes', () => {
  it('removes a user\u2019s repositories when the user is deleted', async () => {
    const user = await makeUser(1, 'octocat');
    await connectRepository({ userId: user.id, ...sampleRepo });

    await query('DELETE FROM users WHERE id = $1', [user.id]);

    const { rows } = await query<{ count: string }>('SELECT count(*) AS count FROM repositories');
    expect(rows[0].count).toBe('0');
  });
});
