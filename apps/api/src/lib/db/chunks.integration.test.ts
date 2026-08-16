import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from './client.js';
import { findOrCreateUser } from './users.js';
import { connectRepository } from './repositories.js';
import { startIngestionRun } from './ingestion-runs.js';
import {
  EMBEDDING_DIMENSIONS,
  insertChunks,
  insertEmbeddings,
  insertFile,
  nearestChunks,
  type Chunk,
  type RepositoryFile,
} from './chunks.js';

const COMMIT = 'a'.repeat(40);
const MODEL = 'bge-small-en-v1.5';

/**
 * On a table small enough to sort in memory the planner is right to prefer a
 * sequential scan, so proving the HNSW index is reachable needs a corpus past
 * the crossover. That sits just under two thousand rows on pg17 with these
 * index parameters; the margin here absorbs the difference between a laptop
 * and the CI runner.
 */
const CORPUS_SIZE = 2_500;

/**
 * A unit vector along one axis. Cosine distance between two different axes is
 * exactly 1 and between an axis and itself exactly 0, so proximity in these
 * tests is arranged rather than approximated.
 */
function axisVector(axis: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  embedding[axis % EMBEDDING_DIMENSIONS] = 1;
  return embedding;
}

async function makeRepository(githubId = 1, githubName = 'hello-world') {
  const user = await findOrCreateUser({
    githubId,
    githubUsername: `user-${githubId}`,
    githubAvatar: `https://avatars.githubusercontent.com/u/${githubId}`,
  });

  const repository = await connectRepository({
    userId: user.id,
    githubId: 900_000 + githubId,
    githubOwner: 'octocat',
    githubName,
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

async function makeFile(
  repositoryId: string,
  runId: string,
  path = 'src/index.ts'
): Promise<RepositoryFile> {
  return insertFile({
    repositoryId,
    runId,
    path,
    language: 'typescript',
    sizeBytes: 1_024,
    sha256: 'b'.repeat(64),
  });
}

async function makeChunk(
  file: RepositoryFile,
  content = 'export const answer = 42;'
): Promise<Chunk> {
  const [chunk] = await insertChunks([
    {
      fileId: file.id,
      repositoryId: file.repositoryId,
      startLine: 1,
      endLine: 3,
      symbol: 'answer',
      kind: 'declaration',
      content,
      tokenCount: 8,
    },
  ]);
  return chunk;
}

async function countRows(table: string): Promise<number> {
  const { rows } = await query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
  return Number(rows[0].count);
}

function hasSqlState(code: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** 22000 data_exception, raised by pgvector when a literal is the wrong width. */
const isDataException = hasSqlState('22000');
/** 23514 check_violation, raised here by the end_line >= start_line check. */
const isCheckViolation = hasSqlState('23514');

beforeEach(async () => {
  await query('TRUNCATE users CASCADE');
});

afterAll(async () => {
  await closePool();
});

describe('insertChunks', () => {
  it('returns chunks in the order they were given', async () => {
    // Embeddings are computed separately and paired with chunks by position, so
    // a reordered result would attach each vector to the wrong text.
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);

    const inputs = Array.from({ length: 20 }, (_, i) => ({
      fileId: file.id,
      repositoryId: repository.id,
      startLine: i + 1,
      endLine: i + 2,
      symbol: null,
      kind: 'block',
      content: `line ${i}`,
      tokenCount: 3,
    }));

    const chunks = await insertChunks(inputs);

    expect(chunks).toHaveLength(20);
    expect(chunks.map((c) => c.content)).toEqual(inputs.map((i) => i.content));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(20);
  });

  it('writes nothing and issues no query for an empty batch', async () => {
    expect(await insertChunks([])).toEqual([]);
    expect(await countRows('chunks')).toBe(0);
  });

  it('rejects a chunk whose end line precedes its start line', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);

    // An inverted span is how an off-by-one in the chunker escapes into the
    // index, where it surfaces as a citation pointing at nothing.
    await expect(
      insertChunks([
        {
          fileId: file.id,
          repositoryId: repository.id,
          startLine: 40,
          endLine: 12,
          symbol: null,
          kind: 'block',
          content: 'inverted',
          tokenCount: 1,
        },
      ])
    ).rejects.toSatisfy(isCheckViolation);

    expect(await countRows('chunks')).toBe(0);
  });

  it('accepts a single line chunk where the span starts and ends together', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);

    const [chunk] = await insertChunks([
      {
        fileId: file.id,
        repositoryId: repository.id,
        startLine: 7,
        endLine: 7,
        symbol: null,
        kind: 'statement',
        content: 'import fs from "node:fs";',
        tokenCount: 6,
      },
    ]);

    expect(chunk.startLine).toBe(7);
    expect(chunk.endLine).toBe(7);
  });
});

describe('content_tsv', () => {
  async function readTsv(chunkId: string): Promise<string> {
    const { rows } = await query<{ content_tsv: string }>(
      'SELECT content_tsv::text AS content_tsv FROM chunks WHERE id = $1',
      [chunkId]
    );
    return rows[0].content_tsv;
  }

  it('populates the full text column without an explicit write', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file, 'the retry policies are jumping between queues');

    const tsv = await readTsv(chunk.id);

    // Stemmed and stopword-filtered, which is what proves the english
    // configuration ran rather than a raw copy of the text.
    expect(tsv).toContain('polici');
    expect(tsv).toContain('jump');
    expect(tsv).not.toContain('the');
  });

  it('updates the full text column when content changes', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file, 'the retry policies are jumping between queues');

    await query('UPDATE chunks SET content = $2 WHERE id = $1', [
      chunk.id,
      'the bucket lifecycle expires objects',
    ]);

    const tsv = await readTsv(chunk.id);
    expect(tsv).toContain('lifecycl');
    expect(tsv).not.toContain('polici');
  });

  it('refuses a direct write to the generated column', async () => {
    // The column is generated precisely so no writer can make it disagree with
    // content. A trigger-maintained column would accept this.
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file);

    await expect(
      query(`UPDATE chunks SET content_tsv = to_tsvector('english', 'lies') WHERE id = $1`, [
        chunk.id,
      ])
    ).rejects.toThrow();
  });
});

describe('insertEmbeddings', () => {
  it('rejects an embedding with the wrong dimension', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file);

    // Everything else about the row is valid, so the column type is the only
    // thing that can reject it. A model swapped for one with a different width
    // has to fail here rather than poison the index silently.
    await expect(
      insertEmbeddings([
        { chunkId: chunk.id, repositoryId: repository.id, model: MODEL, embedding: [1, 2, 3] },
      ])
    ).rejects.toSatisfy(isDataException);

    expect(await countRows('chunk_embeddings')).toBe(0);
  });

  it('accepts an embedding of exactly the model dimension', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file);

    const written = await insertEmbeddings([
      {
        chunkId: chunk.id,
        repositoryId: repository.id,
        model: MODEL,
        embedding: axisVector(0),
      },
    ]);

    expect(written).toBe(1);
  });

  it('replaces the vector when a chunk is embedded again', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file);

    await insertEmbeddings([
      {
        chunkId: chunk.id,
        repositoryId: repository.id,
        model: 'old-model',
        embedding: axisVector(0),
      },
    ]);
    await insertEmbeddings([
      { chunkId: chunk.id, repositoryId: repository.id, model: MODEL, embedding: axisVector(5) },
    ]);

    const { rows } = await query<{ model: string }>(
      'SELECT model FROM chunk_embeddings WHERE chunk_id = $1',
      [chunk.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe(MODEL);
  });

  it('writes nothing for an empty batch', async () => {
    expect(await insertEmbeddings([])).toBe(0);
  });
});

describe('nearestChunks', () => {
  it("never returns another repository's chunks", async () => {
    const mine = await makeRepository(1, 'mine');
    const theirs = await makeRepository(2, 'theirs');

    const myFile = await makeFile(mine.repository.id, mine.run.id, 'src/mine.ts');
    const theirFile = await makeFile(theirs.repository.id, theirs.run.id, 'src/theirs.ts');

    const myChunks = await insertChunks(
      [1, 2, 3].map((i) => ({
        fileId: myFile.id,
        repositoryId: mine.repository.id,
        startLine: i,
        endLine: i,
        symbol: null,
        kind: 'block',
        content: `mine ${i}`,
        tokenCount: 2,
      }))
    );
    const theirChunks = await insertChunks(
      [1, 2, 3].map((i) => ({
        fileId: theirFile.id,
        repositoryId: theirs.repository.id,
        startLine: i,
        endLine: i,
        symbol: null,
        kind: 'block',
        content: `theirs ${i}`,
        tokenCount: 2,
      }))
    );

    // The other repository's chunks sit exactly on the probe and mine a full
    // cosine unit away, so an unfiltered search would return theirs first.
    await insertEmbeddings(
      myChunks.map((c) => ({
        chunkId: c.id,
        repositoryId: mine.repository.id,
        model: MODEL,
        embedding: axisVector(1),
      }))
    );
    await insertEmbeddings(
      theirChunks.map((c) => ({
        chunkId: c.id,
        repositoryId: theirs.repository.id,
        model: MODEL,
        embedding: axisVector(0),
      }))
    );

    const found = await nearestChunks({
      repositoryId: mine.repository.id,
      embedding: axisVector(0),
      limit: 10,
    });

    expect(found).toHaveLength(3);
    expect(found.map((n) => n.chunkId).sort()).toEqual(myChunks.map((c) => c.id).sort());
    for (const neighbour of found) {
      expect(neighbour.path).toBe('src/mine.ts');
      expect(neighbour.content).toMatch(/^mine /);
    }
  });

  it('orders neighbours by cosine distance and reports it', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);

    const chunks = await insertChunks(
      [0, 1].map((i) => ({
        fileId: file.id,
        repositoryId: repository.id,
        startLine: i + 1,
        endLine: i + 1,
        symbol: null,
        kind: 'block',
        content: `axis ${i}`,
        tokenCount: 2,
      }))
    );

    await insertEmbeddings(
      chunks.map((c, i) => ({
        chunkId: c.id,
        repositoryId: repository.id,
        model: MODEL,
        embedding: axisVector(i),
      }))
    );

    const found = await nearestChunks({ repositoryId: repository.id, embedding: axisVector(0) });

    expect(found.map((n) => n.chunkId)).toEqual([chunks[0].id, chunks[1].id]);
    expect(found[0].distance).toBeCloseTo(0, 5);
    expect(found[1].distance).toBeCloseTo(1, 5);
  });

  it('returns nothing for a repository that has not been embedded', async () => {
    const { repository } = await makeRepository();
    expect(await nearestChunks({ repositoryId: repository.id, embedding: axisVector(0) })).toEqual(
      []
    );
  });

  it('refuses a limit or ef_search the index cannot honour', async () => {
    const { repository } = await makeRepository();
    const embedding = axisVector(0);

    await expect(
      nearestChunks({ repositoryId: repository.id, embedding, limit: 0 })
    ).rejects.toThrow(/limit must be a positive integer/);
    await expect(
      nearestChunks({ repositoryId: repository.id, embedding, efSearch: 5_000 })
    ).rejects.toThrow(/efSearch must be an integer/);
  });
});

describe('the hnsw index', () => {
  it('uses the hnsw index rather than a sequential scan', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);

    const chunks = await insertChunks(
      Array.from({ length: CORPUS_SIZE }, (_, i) => ({
        fileId: file.id,
        repositoryId: repository.id,
        startLine: i + 1,
        endLine: i + 1,
        symbol: null,
        kind: 'block',
        content: `corpus ${i}`,
        tokenCount: 2,
      }))
    );

    await insertEmbeddings(
      chunks.map((c, i) => ({
        chunkId: c.id,
        repositoryId: repository.id,
        model: MODEL,
        embedding: axisVector(i),
      }))
    );

    // The planner needs statistics; autovacuum has not run on a table this new.
    await query('ANALYZE chunk_embeddings');

    const { rows } = await query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT chunk_id FROM chunk_embeddings
        ORDER BY embedding <=> $1::halfvec
        LIMIT 10`,
      [`[${axisVector(0).join(',')}]`]
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');

    expect(plan).toContain('chunk_embeddings_hnsw_idx');
    expect(plan).not.toContain('Seq Scan on chunk_embeddings');
  });
});

describe('cascading deletes', () => {
  it('cascades deletion from run to file to chunk to embedding', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file);
    await insertEmbeddings([
      { chunkId: chunk.id, repositoryId: repository.id, model: MODEL, embedding: axisVector(0) },
    ]);

    // Discarding a half-finished pass has to be one delete. Anything it leaves
    // behind degrades retrieval without announcing itself.
    await query('DELETE FROM ingestion_runs WHERE id = $1', [run.id]);

    expect(await countRows('files')).toBe(0);
    expect(await countRows('chunks')).toBe(0);
    expect(await countRows('chunk_embeddings')).toBe(0);
    expect(await countRows('repositories')).toBe(1);
  });

  it('cascades deletion from repository through every artefact it owns', async () => {
    const { repository, run } = await makeRepository();
    const file = await makeFile(repository.id, run.id);
    const chunk = await makeChunk(file);
    await insertEmbeddings([
      { chunkId: chunk.id, repositoryId: repository.id, model: MODEL, embedding: axisVector(0) },
    ]);

    await query('DELETE FROM repositories WHERE id = $1', [repository.id]);

    expect(await countRows('files')).toBe(0);
    expect(await countRows('chunks')).toBe(0);
    expect(await countRows('chunk_embeddings')).toBe(0);
  });

  it('keeps a file unique within its run', async () => {
    const { repository, run } = await makeRepository();
    await makeFile(repository.id, run.id, 'src/index.ts');

    await expect(makeFile(repository.id, run.id, 'src/index.ts')).rejects.toSatisfy(
      hasSqlState('23505')
    );
  });
});
