import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { connectRepository } from './repositories.js';
import { startIngestionRun } from './ingestion-runs.js';
import { insertNodes, type GraphNode } from './graph.js';
import {
  communitiesForRun,
  communityForNode,
  communityMembers,
  insertCommunities,
  type NewGraphCommunity,
} from './communities.js';

const COMMIT = 'c'.repeat(40);

async function makeRepository(githubId = 1) {
  const user = await findOrCreateUser({
    githubId,
    githubUsername: `user-${githubId}`,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });

  const repository = await connectRepository({
    userId: user.id,
    githubId: 700_000 + githubId,
    githubOwner: 'octocat',
    githubName: `repo-${githubId}`,
    defaultBranch: 'main',
    isPrivate: false,
  });

  const run = await startIngestionRun({
    repositoryId: repository.id,
    commitSha: COMMIT,
    ref: 'refs/heads/main',
  });

  return { user, repository, run };
}

/** Six symbols, named so their qualified-name order is their array order. */
async function makeNodes(repositoryId: string, runId: string): Promise<GraphNode[]> {
  return insertNodes(
    runId,
    Array.from({ length: 6 }, (_, i) => ({
      repositoryId,
      kind: 'function' as const,
      qualifiedName: `src/mod${Math.floor(i / 3)}.ts::symbol${i}`,
      displayName: `symbol${i}`,
    }))
  );
}

/**
 * Two level-0 communities of three symbols, both inside one level-1 community.
 * The smallest hierarchy that exercises the parent link and the nesting.
 */
function twoLevels(repositoryId: string, nodes: readonly GraphNode[]): NewGraphCommunity[] {
  return [
    {
      repositoryId,
      level: 0,
      ordinal: 0,
      parentOrdinal: 0,
      quality: 1.5,
      nodeIds: nodes.slice(0, 3).map((n) => n.id),
    },
    {
      repositoryId,
      level: 0,
      ordinal: 1,
      parentOrdinal: 0,
      quality: 1.5,
      nodeIds: nodes.slice(3).map((n) => n.id),
    },
    {
      repositoryId,
      level: 1,
      ordinal: 0,
      parentOrdinal: null,
      quality: 2.25,
      nodeIds: nodes.map((n) => n.id),
    },
  ];
}

async function countRows(table: string): Promise<number> {
  const { rows } = await query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
  return Number(rows[0].count);
}

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('insertCommunities', () => {
  it('writes a hierarchy ordered by level and ordinal', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);

    const written = await insertCommunities(run.id, twoLevels(repository.id, nodes));

    expect(written.map((c) => [c.level, c.ordinal])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(written.map((c) => c.nodeCount)).toEqual([3, 3, 6]);
    expect(written[0].repositoryId).toBe(repository.id);
    expect(written[0].runId).toBe(run.id);
    expect(written[0].quality).toBeCloseTo(1.5, 5);
    expect(await countRows('graph_community_members')).toBe(12);
  });

  it('resolves each parent ordinal to the community one level above', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);

    const written = await insertCommunities(run.id, twoLevels(repository.id, nodes));
    const top = written.find((c) => c.level === 1);
    if (!top) throw new Error('no level 1 community');

    expect(written.filter((c) => c.level === 0).map((c) => c.parentId)).toEqual([top.id, top.id]);
    expect(top.parentId).toBeNull();
  });

  it('returns an empty array without touching the database for no communities', async () => {
    const { run } = await makeRepository();

    expect(await insertCommunities(run.id, [])).toEqual([]);
    expect(await countRows('graph_communities')).toBe(0);
  });

  it('rejects a community with no members', async () => {
    const { repository, run } = await makeRepository();

    await expect(
      insertCommunities(run.id, [
        { repositoryId: repository.id, level: 0, ordinal: 0, quality: 0, nodeIds: [] },
      ])
    ).rejects.toThrow(/no members/);
    expect(await countRows('graph_communities')).toBe(0);
  });

  it('rolls back when a parent ordinal names no community in the batch', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);

    await expect(
      insertCommunities(run.id, [
        {
          repositoryId: repository.id,
          level: 0,
          ordinal: 0,
          parentOrdinal: 7,
          quality: 1,
          nodeIds: nodes.slice(0, 3).map((n) => n.id),
        },
      ])
    ).rejects.toThrow(/find a parent/);

    // The partition is recomputable; half of one written to the database is not.
    expect(await countRows('graph_communities')).toBe(0);
    expect(await countRows('graph_community_members')).toBe(0);
  });

  it('rejects a second community with the same run, level and ordinal', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    const first: NewGraphCommunity = {
      repositoryId: repository.id,
      level: 0,
      ordinal: 0,
      quality: 1,
      nodeIds: nodes.slice(0, 3).map((n) => n.id),
    };

    await insertCommunities(run.id, [first]);
    await expect(
      insertCommunities(run.id, [{ ...first, nodeIds: nodes.slice(3).map((n) => n.id) }])
    ).rejects.toThrow();
  });

  it('removes the communities and their members with the run', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    await insertCommunities(run.id, twoLevels(repository.id, nodes));

    await query('DELETE FROM ingestion_runs WHERE id = $1', [run.id]);

    expect(await countRows('graph_communities')).toBe(0);
    expect(await countRows('graph_community_members')).toBe(0);
  });
});

describe('communitiesForRun', () => {
  it('returns every level when none is given', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    await insertCommunities(run.id, twoLevels(repository.id, nodes));

    const all = await communitiesForRun(run.id);
    expect(all.map((c) => c.level)).toEqual([0, 0, 1]);
  });

  it('returns only the level asked for', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    await insertCommunities(run.id, twoLevels(repository.id, nodes));

    const level0 = await communitiesForRun(run.id, 0);
    expect(level0.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(await communitiesForRun(run.id, 2)).toEqual([]);
  });

  it('rejects a level that is not a non-negative integer', async () => {
    const { run } = await makeRepository();

    await expect(communitiesForRun(run.id, -1)).rejects.toThrow(/non-negative integer/);
    await expect(communitiesForRun(run.id, 1.5)).rejects.toThrow(/non-negative integer/);
  });
});

describe('communityMembers', () => {
  it('returns the symbols of one community by qualified name', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    const written = await insertCommunities(run.id, twoLevels(repository.id, nodes));

    const members = await communityMembers(written[0].id);
    expect(members.map((m) => m.qualifiedName)).toEqual([
      'src/mod0.ts::symbol0',
      'src/mod0.ts::symbol1',
      'src/mod0.ts::symbol2',
    ]);
    expect(members.map((m) => m.nodeId)).toEqual(nodes.slice(0, 3).map((n) => n.id));
  });

  it('returns nothing for a community that does not exist', async () => {
    await makeRepository();
    expect(await communityMembers('00000000-0000-0000-0000-000000000000')).toEqual([]);
  });
});

describe('communityForNode', () => {
  it('finds the finest community holding a symbol', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    await insertCommunities(run.id, twoLevels(repository.id, nodes));

    const community = await communityForNode(nodes[4].id);
    expect(community?.level).toBe(0);
    expect(community?.ordinal).toBe(1);
  });

  it('finds the community at a level above', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    await insertCommunities(run.id, twoLevels(repository.id, nodes));

    const community = await communityForNode(nodes[4].id, 1);
    expect(community?.ordinal).toBe(0);
    expect(community?.nodeCount).toBe(6);
  });

  it('returns null above the top level', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);
    await insertCommunities(run.id, twoLevels(repository.id, nodes));

    expect(await communityForNode(nodes[0].id, 2)).toBeNull();
  });

  it('rejects a level that is not a non-negative integer', async () => {
    const { repository, run } = await makeRepository();
    const nodes = await makeNodes(repository.id, run.id);

    await expect(communityForNode(nodes[0].id, -2)).rejects.toThrow(/non-negative integer/);
  });
});
