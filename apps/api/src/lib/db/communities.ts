// The community hierarchy a run's partition produced: which symbols cluster
// together, and how those clusters nest. Detection itself is the engine's work,
// and nothing here clusters anything.
import { query, withTransaction } from './client.js';

export interface GraphCommunity {
  id: string;
  repositoryId: string;
  runId: string;
  /** 0 is the finest partition; each level above aggregates the one below. */
  level: number;
  parentId: string | null;
  /** Stable within (run, level): ascending smallest member qualified name. */
  ordinal: number;
  nodeCount: number;
  /** CPM quality of the level this community belongs to. */
  quality: number;
  createdAt: Date;
}

export interface NewGraphCommunity {
  repositoryId: string;
  level: number;
  ordinal: number;
  /** Ordinal of the community at `level + 1` that holds this one. */
  parentOrdinal?: number | null;
  quality: number;
  /** Ids of the `graph_nodes` rows in this community. Must not be empty. */
  nodeIds: readonly string[];
}

export interface CommunityMember {
  nodeId: string;
  qualifiedName: string;
}

interface CommunityRow {
  id: string;
  repository_id: string;
  run_id: string;
  level: number;
  parent_id: string | null;
  ordinal: number;
  node_count: number;
  quality: number;
  created_at: Date;
}

interface MemberRow {
  node_id: string;
  qualified_name: string;
}

function toCommunity(row: CommunityRow): GraphCommunity {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    runId: row.run_id,
    level: row.level,
    parentId: row.parent_id,
    ordinal: row.ordinal,
    nodeCount: row.node_count,
    quality: Number(row.quality),
    createdAt: row.created_at,
  };
}

/**
 * Write a run's whole community hierarchy and return it in the order given.
 *
 * One statement per table rather than a round trip per community: a large
 * repository partitions into tens of thousands of them across the levels, and
 * the write would otherwise cost more than the detection did.
 *
 * Parents are resolved in a second pass rather than being supplied as ids. The
 * caller has ordinals, which is what the engine produces and what a summary is
 * cached against; the ids do not exist until this call creates them, so a
 * caller could not name a parent by id even if it wanted to.
 *
 * The whole hierarchy goes in one transaction. A partially written level is
 * worse than none: a reader walking `parent_id` upwards would find a tree that
 * silently stops, rather than an absent partition it can recompute.
 */
export async function insertCommunities(
  runId: string,
  communities: readonly NewGraphCommunity[]
): Promise<GraphCommunity[]> {
  if (communities.length === 0) return [];

  const empty = communities.find((c) => c.nodeIds.length === 0);
  if (empty) {
    throw new Error(`community ${empty.level}/${empty.ordinal} has no members`);
  }

  return withTransaction(async (client) => {
    const inserted = await client.query<CommunityRow>(
      `INSERT INTO graph_communities (repository_id, run_id, level, ordinal, node_count, quality)
       SELECT t.repository_id, $1::uuid, t.level, t.ordinal, t.node_count, t.quality
         FROM unnest($2::uuid[], $3::smallint[], $4::int[], $5::int[], $6::real[])
              AS t(repository_id, level, ordinal, node_count, quality)
       RETURNING *`,
      [
        runId,
        communities.map((c) => c.repositoryId),
        communities.map((c) => c.level),
        communities.map((c) => c.ordinal),
        communities.map((c) => c.nodeIds.length),
        communities.map((c) => c.quality),
      ]
    );

    const withParents = communities.filter(
      (c) => c.parentOrdinal !== undefined && c.parentOrdinal !== null
    );
    if (withParents.length > 0) {
      const linked = await client.query(
        `UPDATE graph_communities child
            SET parent_id = parent.id
           FROM unnest($2::int[], $3::int[], $4::int[])
                AS t(level, ordinal, parent_ordinal)
           JOIN graph_communities parent
             ON parent.run_id = $1::uuid
            AND parent.level  = t.level + 1
            AND parent.ordinal = t.parent_ordinal
          WHERE child.run_id = $1::uuid
            AND child.level  = t.level
            AND child.ordinal = t.ordinal`,
        [
          runId,
          withParents.map((c) => c.level),
          withParents.map((c) => c.ordinal),
          withParents.map((c) => c.parentOrdinal),
        ]
      );
      // A parent ordinal naming a community that is not in the batch would
      // otherwise leave the child looking like a root, which reads as a valid
      // hierarchy with a level quietly missing from it.
      if ((linked.rowCount ?? 0) !== withParents.length) {
        throw new Error(
          `expected ${withParents.length} communities to find a parent, linked ${linked.rowCount ?? 0}`
        );
      }
    }

    // `RETURNING` makes no promise about row order, so the ids are paired back
    // to their input by (level, ordinal) rather than by position.
    const idOf = new Map<string, string>(
      inserted.rows.map((row) => [`${row.level}/${row.ordinal}`, row.id])
    );
    const communityIds: string[] = [];
    const nodeIds: string[] = [];
    for (const community of communities) {
      const id = idOf.get(`${community.level}/${community.ordinal}`);
      if (id === undefined) {
        throw new Error(`community ${community.level}/${community.ordinal} was not written`);
      }
      for (const nodeId of community.nodeIds) {
        communityIds.push(id);
        nodeIds.push(nodeId);
      }
    }

    await client.query(
      `INSERT INTO graph_community_members (community_id, node_id)
       SELECT * FROM unnest($1::uuid[], $2::uuid[])`,
      [communityIds, nodeIds]
    );

    const result = await client.query<CommunityRow>(
      `SELECT * FROM graph_communities
        WHERE run_id = $1::uuid
        ORDER BY level, ordinal`,
      [runId]
    );
    return result.rows.map(toCommunity);
  });
}

/**
 * A run's communities, finest level first, optionally one level only.
 *
 * Ordered by (level, ordinal) so a caller rendering the hierarchy gets it in
 * the order the ordinals mean, without sorting it again.
 */
export async function communitiesForRun(runId: string, level?: number): Promise<GraphCommunity[]> {
  if (level !== undefined && (!Number.isInteger(level) || level < 0)) {
    throw new Error(`level must be a non-negative integer, got ${level}`);
  }

  const result = await query<CommunityRow>(
    `SELECT * FROM graph_communities
      WHERE run_id = $1::uuid
        AND ($2::smallint IS NULL OR level = $2::smallint)
      ORDER BY level, ordinal`,
    [runId, level ?? null]
  );

  return result.rows.map(toCommunity);
}

/** The symbols in one community, by qualified name. */
export async function communityMembers(communityId: string): Promise<CommunityMember[]> {
  const result = await query<MemberRow>(
    `SELECT m.node_id, n.qualified_name
       FROM graph_community_members m
       JOIN graph_nodes n ON n.id = m.node_id
      WHERE m.community_id = $1::uuid
      ORDER BY n.qualified_name`,
    [communityId]
  );

  return result.rows.map((row) => ({ nodeId: row.node_id, qualifiedName: row.qualified_name }));
}

/**
 * The community one symbol sits in at a given level, or null if the run's
 * partition does not reach that level.
 *
 * Level 0 by default: a caller asking what a symbol belongs to almost always
 * wants the tightest cluster, and can walk `parent_id` upwards for the rest.
 */
export async function communityForNode(nodeId: string, level = 0): Promise<GraphCommunity | null> {
  if (!Number.isInteger(level) || level < 0) {
    throw new Error(`level must be a non-negative integer, got ${level}`);
  }

  const result = await query<CommunityRow>(
    `SELECT c.*
       FROM graph_community_members m
       JOIN graph_communities c ON c.id = m.community_id
      WHERE m.node_id = $1::uuid
        AND c.level = $2::smallint`,
    [nodeId, level]
  );

  const row = result.rows[0];
  return row ? toCommunity(row) : null;
}
