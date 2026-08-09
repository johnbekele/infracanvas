---
title: '[db] Chunk and embedding tables with a halfvec HNSW index'
labels: tier:2, size:m, area:db, epic:1-data
---

### Epic

#2

### Context

Retrieval reads from here, so the shape of these tables sets the ceiling on both recall and memory
use for the rest of the project.

Two choices need justifying because they are hard to reverse once there is data:

**`halfvec` rather than `vector`.** A 384-dimension `vector` costs 1536 bytes per row; `halfvec`
costs 768. At a million chunks that is the difference between roughly 1.5GB and 750MB of index, and
the recall loss for normalised embeddings from `bge-small-en-v1.5` is within noise. The project's
stated goal is to run well on an ordinary laptop, and this is the single largest lever on that.

**HNSW rather than IVFFlat.** IVFFlat needs representative data present before the index is built
and degrades when the corpus grows past what its lists were tuned for. HNSW has a higher build cost
but does not need retuning as repositories are added, which matters when every user ingests a
different codebase.

The full-text column is created here as well, so that the BM25 half of hybrid retrieval has
somewhere to read from without a second migration later.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  path          text NOT NULL,
  language      text NOT NULL,
  size_bytes    integer NOT NULL,
  sha256        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, path)
);

CREATE TABLE chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  start_line  integer NOT NULL,
  end_line    integer NOT NULL,
  symbol      text,
  kind        text NOT NULL,
  content     text NOT NULL,
  token_count integer NOT NULL,
  -- Generated rather than trigger-maintained so it can never disagree with content.
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_line >= start_line)
);

CREATE INDEX chunks_repository_idx ON chunks (repository_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (content_tsv);

CREATE TABLE chunk_embeddings (
  chunk_id   uuid PRIMARY KEY REFERENCES chunks (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  model      text NOT NULL,
  embedding  halfvec(384) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chunk_embeddings_hnsw_idx
  ON chunk_embeddings USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

`repository_id` is denormalised onto `chunks` and `chunk_embeddings` deliberately: every retrieval
query filters by repository, and without it each filter would need a two-table join that the HNSW
index cannot use.

### Files

- CREATE `db/migrations/<timestamp>_chunks_and_embeddings.sql`
- CREATE `apps/api/src/lib/db/chunks.ts`
- CREATE `apps/api/src/lib/db/chunks.integration.test.ts`

### Acceptance Criteria

- [ ] The migration applies, rolls back, and reapplies on `pgvector/pgvector:pg17`
- [ ] Inserting an embedding of the wrong dimension is rejected by the database
- [ ] A chunk with `end_line` before `start_line` is rejected
- [ ] `content_tsv` is populated automatically and updates when `content` changes
- [ ] A cosine nearest-neighbour query filtered by `repository_id` returns only that repository's chunks
- [ ] `EXPLAIN` shows the HNSW index in use for an unfiltered nearest-neighbour query
- [ ] Deleting a run removes its files, chunks, and embeddings

### Required Tests

- `rejects an embedding with the wrong dimension`
- `rejects a chunk whose end line precedes its start line`
- `populates the full text column without an explicit write`
- `updates the full text column when content changes`
- `nearest neighbour search never returns another repository's chunks`
- `uses the hnsw index rather than a sequential scan`
- `cascades deletion from run to file to chunk to embedding`

### Performance Budget

Nearest-neighbour query over 100k chunks returns in under 50ms at `ef_search = 40`, measured on the
CI runner. Index size for 100k chunks stays under 100MB.

### Out of Scope

- Do not implement chunking, parsing, or embedding generation; this issue creates storage only
- Do not add the hybrid retrieval query; that belongs to the retrieval epic
- Do not change `m` or `ef_construction` without recording the recall measurement that justified it

### Dependencies

Blocked by #24.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm --filter @infracanvas/api test:integration
psql "$DATABASE_URL" -c "\d+ chunk_embeddings"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
