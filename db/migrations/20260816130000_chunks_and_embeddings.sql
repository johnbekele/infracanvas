-- migrate:up

-- One source file as a single ingestion pass saw it.
--
-- Keyed by run rather than by repository so two runs over different commits can
-- coexist while the newer one is still being written. Retrieval reads through
-- the latest succeeded run, so a half-finished pass is invisible until it
-- commits, and discarding it is a single delete.
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid        NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid        NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  path          text        NOT NULL,
  language      text        NOT NULL,
  size_bytes    integer     NOT NULL,
  sha256        text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (run_id, path)
);

-- A span of one file, as produced by the chunker.
--
-- `repository_id` is denormalised from `files` deliberately: every retrieval
-- query filters by repository, and a join to reach the filter is something the
-- HNSW index below cannot see through.
CREATE TABLE chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       uuid        NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  repository_id uuid        NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  start_line    integer     NOT NULL,
  end_line      integer     NOT NULL,
  -- Null for a chunk that is not a named declaration: a module header, a block
  -- of top-level statements, an oversized body split across several rows.
  symbol        text,
  kind          text        NOT NULL,
  content       text        NOT NULL,
  token_count   integer     NOT NULL,
  -- Generated rather than trigger-maintained so it can never disagree with content.
  content_tsv   tsvector    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CHECK (end_line >= start_line)
);

CREATE INDEX chunks_repository_idx ON chunks (repository_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (content_tsv);

-- Not in the issue's contract, and added because the cascade needs it: without
-- an index on the referencing side, deleting one file makes Postgres scan every
-- chunk row, so discarding a run costs one full table scan per file it wrote.
CREATE INDEX chunks_file_idx ON chunks (file_id);

-- Embeddings live apart from `chunks` so that re-embedding under a new model
-- does not rewrite the text, and so the HNSW index below covers a narrow table.
--
-- `halfvec` rather than `vector`: 384 dimensions cost 768 bytes per row instead
-- of 1536, which halves the index for a million chunks from roughly 1.5GB to
-- 750MB. The recall loss on normalised bge-small-en-v1.5 output is within noise,
-- and fitting the index in an ordinary laptop's memory is worth far more.
CREATE TABLE chunk_embeddings (
  chunk_id      uuid PRIMARY KEY REFERENCES chunks (id) ON DELETE CASCADE,
  repository_id uuid         NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  -- Recorded per row rather than per run: a corpus embedded by two models is
  -- unsearchable, and without the model name there is no way to notice.
  model         text         NOT NULL,
  embedding     halfvec(384) NOT NULL,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- HNSW rather than IVFFlat: IVFFlat wants representative data present before the
-- index is built and degrades once the corpus outgrows the list count it was
-- tuned for. Every user ingests a different repository, so there is no corpus to
-- tune against and nobody to retune when one doubles in size. HNSW costs more to
-- build and nothing to maintain.
--
-- m = 16 and ef_construction = 64 are pgvector's defaults. Changing them
-- requires a recall measurement to justify it.
CREATE INDEX chunk_embeddings_hnsw_idx
  ON chunk_embeddings USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- migrate:down

DROP TABLE IF EXISTS chunk_embeddings;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS files;
