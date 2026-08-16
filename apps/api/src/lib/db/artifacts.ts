// Everything the platform generated for an experiment: the infrastructure
// program, the workflow that deploys it, and the reports produced about it.
import { createHash } from 'node:crypto';
import { query } from './client.js';

export type ArtifactKind =
  | 'pulumi_program'
  | 'workflow'
  | 'cost_report'
  | 'latency_report'
  | 'loadtest_report'
  | 'patch';

export interface Artifact {
  id: string;
  experimentId: string;
  kind: ArtifactKind;
  path: string;
  content: string;
  /** Hex SHA-256 of `content`, computed here so no caller can record a wrong one. */
  contentSha256: string;
  createdAt: Date;
}

interface ArtifactRow {
  id: string;
  experiment_id: string;
  kind: ArtifactKind;
  path: string;
  content: string;
  content_sha256: string;
  created_at: Date;
}

export interface PutArtifactInput {
  experimentId: string;
  kind: ArtifactKind;
  path: string;
  content: string;
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    kind: row.kind,
    path: row.path,
    content: row.content,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Store an artifact, replacing any earlier one of the same kind and path.
 *
 * An upsert rather than an insert because regenerating a program for an
 * experiment is ordinary, and two rows differing only in `created_at` would
 * leave the question of which generated file is the one that would be deployed.
 *
 * The digest is computed from the content rather than accepted from the caller:
 * a hash a caller supplies is a hash nobody checked, and the point of storing
 * one is to be able to tell that what is in the row is what was generated.
 */
export async function putArtifact(input: PutArtifactInput): Promise<Artifact> {
  const digest = createHash('sha256').update(input.content, 'utf8').digest('hex');

  const result = await query<ArtifactRow>(
    `INSERT INTO artifacts (experiment_id, kind, path, content, content_sha256)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (experiment_id, kind, path) DO UPDATE
       SET content        = EXCLUDED.content,
           content_sha256 = EXCLUDED.content_sha256,
           created_at     = now()
     RETURNING *`,
    [input.experimentId, input.kind, input.path, input.content, digest]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to store artifact');
  return toArtifact(row);
}

export async function listArtifacts(
  experimentId: string,
  kind?: ArtifactKind
): Promise<Artifact[]> {
  if (!UUID_PATTERN.test(experimentId)) return [];

  // One statement for both shapes rather than two nearly identical ones: a null
  // `kind` leaves the filter satisfied for every row.
  const result = await query<ArtifactRow>(
    `SELECT * FROM artifacts
      WHERE experiment_id = $1
        AND ($2::artifact_kind IS NULL OR kind = $2::artifact_kind)
      ORDER BY kind, path`,
    [experimentId, kind ?? null]
  );
  return result.rows.map(toArtifact);
}
