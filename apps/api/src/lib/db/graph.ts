// The code property graph a run extracted: which symbol calls which, which
// module imports which, which handler serves which route. Extraction itself is
// the engine's work; nothing here parses anything.
import { query } from './client.js';

export type GraphNodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'function'
  | 'method'
  | 'route'
  | 'table'
  | 'queue'
  | 'external_service';

export type GraphEdgeKind =
  | 'imports'
  | 'calls'
  | 'defines'
  | 'references'
  | 'handles'
  | 'reads'
  | 'writes'
  | 'publishes'
  | 'subscribes';

/** Every edge kind, used when a traversal is not filtered. */
export const GRAPH_EDGE_KINDS: readonly GraphEdgeKind[] = [
  'imports',
  'calls',
  'defines',
  'references',
  'handles',
  'reads',
  'writes',
  'publishes',
  'subscribes',
];

/**
 * The furthest {@link neighbourhood} will walk.
 *
 * Three hops from a seed set already reaches most of a well-connected module,
 * and the row count grows with the branching factor to the power of the depth.
 * A caller that wants more wants a different algorithm, not a larger number.
 */
export const MAX_NEIGHBOURHOOD_DEPTH = 3;

export interface GraphNode {
  id: string;
  repositoryId: string;
  runId: string;
  kind: GraphNodeKind;
  /** Stable within a run: `path/to/file.ts::ClassName::methodName`. */
  qualifiedName: string;
  displayName: string;
  fileId: string | null;
  startLine: number | null;
  endLine: number | null;
  createdAt: Date;
}

export interface NewGraphNode {
  repositoryId: string;
  kind: GraphNodeKind;
  qualifiedName: string;
  displayName: string;
  /** Null for a node with no source of its own: an external service, a queue. */
  fileId?: string | null;
  startLine?: number | null;
  endLine?: number | null;
}

export interface NewGraphEdge {
  repositoryId: string;
  sourceId: string;
  targetId: string;
  kind: GraphEdgeKind;
  /** Extraction confidence or call-site count. Defaults to 1. */
  weight?: number;
}

interface GraphNodeRow {
  id: string;
  repository_id: string;
  run_id: string;
  kind: GraphNodeKind;
  qualified_name: string;
  display_name: string;
  file_id: string | null;
  start_line: number | null;
  end_line: number | null;
  created_at: Date;
}

function toGraphNode(row: GraphNodeRow): GraphNode {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    runId: row.run_id,
    kind: row.kind,
    qualifiedName: row.qualified_name,
    displayName: row.display_name,
    fileId: row.file_id,
    startLine: row.start_line,
    endLine: row.end_line,
    createdAt: row.created_at,
  };
}

/**
 * Write a batch of nodes for one run and return them in the order they were
 * given.
 *
 * The ids are generated in the CTE rather than by the column default for the
 * same reason `insertChunks` does it: edges are built by pairing the caller's
 * own node list with the ids that come back, and `RETURNING` makes no promise
 * about row order. A reordered result would wire every edge to the wrong pair
 * of symbols, which is a graph that looks plausible and is entirely wrong.
 */
export async function insertNodes(
  runId: string,
  nodes: readonly NewGraphNode[]
): Promise<GraphNode[]> {
  if (nodes.length === 0) return [];

  const result = await query<GraphNodeRow>(
    `WITH input AS (
       SELECT gen_random_uuid() AS id, t.*
         FROM unnest($2::uuid[], $3::graph_node_kind[], $4::text[], $5::text[],
                     $6::uuid[], $7::int[], $8::int[])
              WITH ORDINALITY
              AS t(repository_id, kind, qualified_name, display_name,
                   file_id, start_line, end_line, ord)
     ),
     inserted AS (
       INSERT INTO graph_nodes (id, repository_id, run_id, kind, qualified_name,
                                display_name, file_id, start_line, end_line)
       SELECT id, repository_id, $1::uuid, kind, qualified_name,
              display_name, file_id, start_line, end_line
         FROM input
       RETURNING id, created_at
     )
     SELECT i.id, i.repository_id, $1::uuid AS run_id, i.kind, i.qualified_name,
            i.display_name, i.file_id, i.start_line, i.end_line, ins.created_at
       FROM input i
       JOIN inserted ins ON ins.id = i.id
      ORDER BY i.ord`,
    [
      runId,
      nodes.map((n) => n.repositoryId),
      nodes.map((n) => n.kind),
      nodes.map((n) => n.qualifiedName),
      nodes.map((n) => n.displayName),
      nodes.map((n) => n.fileId ?? null),
      nodes.map((n) => n.startLine ?? null),
      nodes.map((n) => n.endLine ?? null),
    ]
  );

  return result.rows.map(toGraphNode);
}

/**
 * Write a batch of edges for one run and return how many were written.
 *
 * A duplicate is left to fail rather than being absorbed by `ON CONFLICT DO
 * NOTHING`. Extraction emits each relationship once, so a collision means two
 * passes are writing into the same run, and silently swallowing it would hide
 * that until the graph disagreed with the source it came from.
 */
export async function insertEdges(runId: string, edges: readonly NewGraphEdge[]): Promise<number> {
  if (edges.length === 0) return 0;

  const result = await query(
    `INSERT INTO graph_edges (repository_id, run_id, source_id, target_id, kind, weight)
     SELECT t.repository_id, $1::uuid, t.source_id, t.target_id, t.kind, t.weight
       FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::graph_edge_kind[], $6::real[])
            AS t(repository_id, source_id, target_id, kind, weight)`,
    [
      runId,
      edges.map((e) => e.repositoryId),
      edges.map((e) => e.sourceId),
      edges.map((e) => e.targetId),
      edges.map((e) => e.kind),
      edges.map((e) => e.weight ?? 1),
    ]
  );

  return result.rowCount ?? 0;
}

/**
 * Breadth-first expansion from a seed set, bounded by hop count.
 *
 * Traversal is undirected: a caller asking what a function touches also wants
 * what touches it, and following only `source_id` would answer half the
 * question. Edges never cross runs because both endpoints belong to one, so the
 * expansion is confined to the seeds' own run without a predicate saying so.
 *
 * The seeds themselves are included in the result, so a depth of 0 returns
 * exactly the seed nodes that exist.
 *
 * Termination does not rely on the graph being acyclic: the recursive term
 * carries the hop count and stops at `depth`, so a cycle costs repeated work
 * within the bound rather than an unbounded loop. `UNION` rather than `UNION
 * ALL` keeps that repeated work from compounding.
 */
export async function neighbourhood(
  nodeIds: readonly string[],
  depth: number,
  kinds?: readonly GraphEdgeKind[]
): Promise<GraphNode[]> {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_NEIGHBOURHOOD_DEPTH) {
    throw new Error(`depth must be an integer in 0..${MAX_NEIGHBOURHOOD_DEPTH}, got ${depth}`);
  }
  if (nodeIds.length === 0) return [];

  // An explicit list rather than `kinds IS NULL OR ...`: the predicate stays the
  // same shape whether or not the caller filtered, so the planner sees one query
  // and the (source_id, kind) index is usable either way. An empty array asks
  // for no edge kinds at all, which correctly yields just the seeds.
  const edgeKinds = kinds ?? GRAPH_EDGE_KINDS;

  const result = await query<GraphNodeRow>(
    `WITH RECURSIVE reachable AS (
       SELECT id AS node_id, 0 AS hop
         FROM graph_nodes
        WHERE id = ANY($1::uuid[])
       UNION
       SELECT CASE WHEN e.source_id = r.node_id THEN e.target_id ELSE e.source_id END,
              r.hop + 1
         FROM reachable r
         JOIN graph_edges e
           ON (e.source_id = r.node_id OR e.target_id = r.node_id)
        WHERE r.hop < $2 AND e.kind = ANY($3::graph_edge_kind[])
     )
     SELECT n.*
       FROM graph_nodes n
      WHERE n.id IN (SELECT node_id FROM reachable)
      ORDER BY n.qualified_name`,
    [nodeIds, depth, edgeKinds]
  );

  return result.rows.map(toGraphNode);
}
