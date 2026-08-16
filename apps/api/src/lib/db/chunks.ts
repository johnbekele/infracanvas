// Storage for what an ingestion run produced: files, their chunks, and the
// embedding of each chunk. Chunking, parsing and embedding themselves belong to
// the engine; nothing here computes anything.
import { query, withTransaction } from './client.js';

/** Fixed by the embedding model, bge-small-en-v1.5, and by the column type. */
export const EMBEDDING_DIMENSIONS = 384;

/**
 * How many candidates HNSW keeps in flight per search. 40 is the value the
 * project's latency budget was measured at; below the requested `limit` the
 * index cannot return that many neighbours at all.
 */
export const DEFAULT_EF_SEARCH = 40;

/** pgvector's own ceiling. A larger value is rejected by the server anyway. */
const MAX_EF_SEARCH = 1000;

export interface RepositoryFile {
  id: string;
  repositoryId: string;
  runId: string;
  path: string;
  language: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

export interface Chunk {
  id: string;
  fileId: string;
  repositoryId: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  kind: string;
  content: string;
  tokenCount: number;
  createdAt: Date;
}

/** A chunk found by vector search, with the file it came from and its distance. */
export interface ChunkNeighbour {
  chunkId: string;
  fileId: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  kind: string;
  content: string;
  /** Cosine distance in [0, 2]; smaller is closer. */
  distance: number;
}

export interface InsertFileInput {
  repositoryId: string;
  runId: string;
  path: string;
  language: string;
  sizeBytes: number;
  sha256: string;
}

export interface InsertChunkInput {
  fileId: string;
  repositoryId: string;
  startLine: number;
  endLine: number;
  symbol?: string | null;
  kind: string;
  content: string;
  tokenCount: number;
}

export interface InsertEmbeddingInput {
  chunkId: string;
  repositoryId: string;
  model: string;
  embedding: readonly number[];
}

export interface NearestChunksInput {
  repositoryId: string;
  embedding: readonly number[];
  /** Default 10. */
  limit?: number;
  /** Default {@link DEFAULT_EF_SEARCH}. */
  efSearch?: number;
}

interface FileRow {
  id: string;
  repository_id: string;
  run_id: string;
  path: string;
  language: string;
  size_bytes: number;
  sha256: string;
  created_at: Date;
}

interface ChunkRow {
  id: string;
  file_id: string;
  repository_id: string;
  start_line: number;
  end_line: number;
  symbol: string | null;
  kind: string;
  content: string;
  token_count: number;
  created_at: Date;
}

interface NeighbourRow {
  chunk_id: string;
  file_id: string;
  path: string;
  start_line: number;
  end_line: number;
  symbol: string | null;
  kind: string;
  content: string;
  distance: number;
}

function toFile(row: FileRow): RepositoryFile {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    runId: row.run_id,
    path: row.path,
    language: row.language,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function toChunk(row: ChunkRow): Chunk {
  return {
    id: row.id,
    fileId: row.file_id,
    repositoryId: row.repository_id,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol,
    kind: row.kind,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

function toNeighbour(row: NeighbourRow): ChunkNeighbour {
  return {
    chunkId: row.chunk_id,
    fileId: row.file_id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol,
    kind: row.kind,
    content: row.content,
    distance: Number(row.distance),
  };
}

/**
 * pgvector parses its own text form, so an embedding crosses the wire as
 * `[0.1,0.2,...]` rather than as a Postgres array.
 *
 * The length is deliberately not checked here. The column type is `halfvec(384)`
 * and three languages write to this table; a guard in the TypeScript client
 * would protect only the writes that need it least, while suggesting the check
 * exists everywhere. The database is the single authority for the dimension.
 */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Record one source file as a run saw it. Unique per (run, path). */
export async function insertFile(input: InsertFileInput): Promise<RepositoryFile> {
  const result = await query<FileRow>(
    `INSERT INTO files (repository_id, run_id, path, language, size_bytes, sha256)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.repositoryId, input.runId, input.path, input.language, input.sizeBytes, input.sha256]
  );

  const row = result.rows[0];
  if (!row) throw new Error('Failed to insert file');
  return toFile(row);
}

/**
 * Write a batch of chunks and return them in the order they were given.
 *
 * A single statement over unnested arrays rather than a loop: a repository of
 * any size produces tens of thousands of chunks, and a round trip each would
 * make ingestion latency a function of network distance rather than of work.
 *
 * The ids are generated in the CTE rather than by the column default so the
 * result can be joined back to its input. `RETURNING` makes no promise about
 * row order, and a caller that pairs chunks with separately computed embeddings
 * by position would silently attach the wrong vector to the wrong text.
 */
export async function insertChunks(inputs: readonly InsertChunkInput[]): Promise<Chunk[]> {
  if (inputs.length === 0) return [];

  const result = await query<ChunkRow>(
    `WITH input AS (
       SELECT gen_random_uuid() AS id, t.*
         FROM unnest($1::uuid[], $2::uuid[], $3::int[], $4::int[],
                     $5::text[], $6::text[], $7::text[], $8::int[])
              WITH ORDINALITY
              AS t(file_id, repository_id, start_line, end_line,
                   symbol, kind, content, token_count, ord)
     ),
     inserted AS (
       INSERT INTO chunks (id, file_id, repository_id, start_line, end_line,
                           symbol, kind, content, token_count)
       SELECT id, file_id, repository_id, start_line, end_line,
              symbol, kind, content, token_count
         FROM input
       RETURNING id, created_at
     )
     SELECT i.id, i.file_id, i.repository_id, i.start_line, i.end_line,
            i.symbol, i.kind, i.content, i.token_count, ins.created_at
       FROM input i
       JOIN inserted ins ON ins.id = i.id
      ORDER BY i.ord`,
    [
      inputs.map((c) => c.fileId),
      inputs.map((c) => c.repositoryId),
      inputs.map((c) => c.startLine),
      inputs.map((c) => c.endLine),
      inputs.map((c) => c.symbol ?? null),
      inputs.map((c) => c.kind),
      inputs.map((c) => c.content),
      inputs.map((c) => c.tokenCount),
    ]
  );

  return result.rows.map(toChunk);
}

/**
 * Attach embeddings to chunks that already exist. Returns the number written.
 *
 * Re-embedding the same chunk overwrites rather than fails: a run that dies
 * after the vectors but before the index can be replayed without first having
 * to work out how far it got.
 */
export async function insertEmbeddings(inputs: readonly InsertEmbeddingInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  const result = await query(
    `INSERT INTO chunk_embeddings (chunk_id, repository_id, model, embedding)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::halfvec[])
     ON CONFLICT (chunk_id) DO UPDATE
       SET model     = EXCLUDED.model,
           embedding = EXCLUDED.embedding`,
    [
      inputs.map((e) => e.chunkId),
      inputs.map((e) => e.repositoryId),
      inputs.map((e) => e.model),
      inputs.map((e) => toVectorLiteral(e.embedding)),
    ]
  );

  return result.rowCount ?? 0;
}

/**
 * Cosine nearest neighbours within one repository.
 *
 * The filter reads `repository_id` from `chunk_embeddings` rather than joining
 * through `chunks`, which is why the column is denormalised onto both tables:
 * a predicate the HNSW scan can evaluate itself keeps the search inside the
 * index, where a join would force a scan of the whole table before ordering.
 */
export async function nearestChunks(input: NearestChunksInput): Promise<ChunkNeighbour[]> {
  const limit = input.limit ?? 10;
  const efSearch = input.efSearch ?? DEFAULT_EF_SEARCH;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isInteger(efSearch) || efSearch < 1 || efSearch > MAX_EF_SEARCH) {
    throw new Error(`efSearch must be an integer in 1..${MAX_EF_SEARCH}, got ${efSearch}`);
  }

  const probe = toVectorLiteral(input.embedding);

  return withTransaction(async (client) => {
    // ef_search is a session GUC, so it needs a transaction to be scoped to one
    // query. set_config takes it as a parameter; `SET LOCAL` would not, and
    // interpolating a value into DDL-shaped SQL is a habit worth not forming.
    await client.query('SELECT set_config($1, $2, true)', ['hnsw.ef_search', String(efSearch)]);

    const result = await client.query<NeighbourRow>(
      `SELECT c.id          AS chunk_id,
              c.file_id,
              f.path,
              c.start_line,
              c.end_line,
              c.symbol,
              c.kind,
              c.content,
              e.embedding <=> $2::halfvec AS distance
         FROM chunk_embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         JOIN files  f ON f.id = c.file_id
        WHERE e.repository_id = $1
        ORDER BY e.embedding <=> $2::halfvec
        LIMIT $3`,
      [input.repositoryId, probe, limit]
    );

    return result.rows.map(toNeighbour);
  });
}
