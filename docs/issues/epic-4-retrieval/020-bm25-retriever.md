---
title: '[brain] BM25 lexical retriever over the generated full text column'
labels: tier:2, size:m, area:brain, area:db, epic:4-retrieval
---

### Epic

#5

### Context

A dense retriever answers "what is this about". It cannot reliably answer "where is
`IC_ENGINE_MAX_FILE_BYTES` read", and no amount of tuning will make it. A 384-dimension model
trained on English prose maps `createUserSession` and `buildAccountToken` to nearby points because
they mean roughly the same thing, and that is precisely the wrong behaviour when a user pastes an
identifier and wants the definition. Rare tokens carry almost all the information in a code search
and are exactly what a small embedding compresses away. Lexical retrieval is not a fallback for the
dense path, it is the half of the system that gets exact matches right.

Postgres ships `ts_rank_cd`, and using it would be a shorter issue. It is rejected because it is not
BM25 and the difference matters on this corpus: `ts_rank_cd` has no corpus-wide inverse document
frequency, so a chunk matching the common word `client` scores like a chunk matching a symbol that
appears in three files, and its length normalisation is a flag rather than the tuned saturation
BM25's `b` parameter gives. On code chunks, which vary from four lines to two hundred, both defects
show up immediately as boilerplate outranking definitions.

Installing an extension that does implement BM25, such as `pg_search`, was the other option. It is
rejected because the deployment target is stock `pgvector/pgvector:pg17` and a self-hosted install
is meant to be one container. Adding a second extension trades a hundred lines of SQL for a
different Postgres image that many managed providers do not offer.

BM25 needs document frequency and average document length, and neither can be computed per query at
this size. They are materialised into two small tables refreshed once at the end of an ingestion
run, rather than maintained by a trigger, because a per-row trigger would serialise an ingest whose
whole point is parallelism.

The tokenisation is fixed by #25: `content_tsv` is `to_tsvector('english', content)`, a generated
column, and changing it means a migration that rewrites every chunk. This issue does not change it.
It compensates on the query side instead. The default parser splits on underscores and leaves
camel case intact, so `read_env` becomes two lexemes and `readEnv` stays one. The retriever
therefore expands the query into both forms, so that a user typing either convention still matches
a codebase written in the other.

Spec: `docs/DATABASE.md`

### Contract

```sql
-- Corpus statistics for BM25. Refreshed once per ingestion run: document
-- frequency is a property of the corpus, and recomputing it per query means
-- scanning every chunk in the repository on every keystroke.
CREATE TABLE chunk_term_stats (
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  lexeme        text NOT NULL,
  doc_freq      integer NOT NULL,
  PRIMARY KEY (repository_id, lexeme)
);

CREATE TABLE chunk_corpus_stats (
  repository_id  uuid PRIMARY KEY REFERENCES repositories (id) ON DELETE CASCADE,
  doc_count      integer NOT NULL,
  avg_doc_length real NOT NULL,
  refreshed_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (doc_count > 0 AND avg_doc_length > 0)
);
```

```sql
-- Refresh, run once per repository at the end of ingest. ts_stat reads the
-- committed tsvectors, so this needs no second pass over the file content.
INSERT INTO chunk_term_stats (repository_id, lexeme, doc_freq)
SELECT $1, word, ndoc
FROM ts_stat(
  format('SELECT content_tsv FROM chunks WHERE repository_id = %L', $1::text)
)
ON CONFLICT (repository_id, lexeme) DO UPDATE SET doc_freq = excluded.doc_freq;
```

```sql
-- Scoring. Two stages on purpose: the gin index picks candidates cheaply, then
-- BM25 is computed only over those, because per-lexeme arithmetic across a
-- million rows is not something an index can help with.
WITH stats AS (
  SELECT doc_count, avg_doc_length FROM chunk_corpus_stats WHERE repository_id = %(repo)s
),
candidates AS (
  SELECT c.id, c.content_tsv, c.token_count
  FROM chunks c
  WHERE c.repository_id = %(repo)s
    AND c.content_tsv @@ %(tsquery)s::tsquery
  LIMIT %(candidate_limit)s
),
scored AS (
  SELECT cand.id,
         sum(
           ln(1 + (s.doc_count - t.doc_freq + 0.5) / (t.doc_freq + 0.5))
           * ((tf.freq * (%(k1)s + 1))
              / (tf.freq
                 + %(k1)s * (1 - %(b)s + %(b)s * cand.token_count / s.avg_doc_length)))
         ) AS bm25
  FROM candidates cand
  CROSS JOIN stats s
  CROSS JOIN LATERAL unnest(cand.content_tsv) AS tv(lexeme, positions, weights)
  JOIN unnest(%(lexemes)s::text[]) AS q(lexeme) ON q.lexeme = tv.lexeme
  JOIN chunk_term_stats t
    ON t.repository_id = %(repo)s AND t.lexeme = tv.lexeme
  CROSS JOIN LATERAL (
    SELECT coalesce(array_length(tv.positions, 1), 1)::real AS freq
  ) tf
  GROUP BY cand.id
)
SELECT sc.id, c.file_id, f.path, c.start_line, c.end_line, c.symbol, c.kind, c.content, sc.bm25
FROM scored sc
JOIN chunks c ON c.id = sc.id
JOIN files f ON f.id = c.file_id
ORDER BY sc.bm25 DESC, sc.id
LIMIT %(limit)s;
```

```python
# services/brain/src/brain/retrieval/bm25.py
K1: Final = 1.2
B: Final = 0.75
CANDIDATE_LIMIT: Final = 500


@dataclass(frozen=True, slots=True)
class Bm25Retriever:
    k1: float = K1
    b: float = B
    candidate_limit: int = CANDIDATE_LIMIT

    @property
    def name(self) -> str:
        return "bm25"

    async def retrieve(
        self, query: RetrievalQuery, pool: AsyncConnectionPool
    ) -> RetrievalResult: ...


def expand_identifier_terms(text: str) -> tuple[str, ...]:
    """Split camel case and snake case identifiers into their parts.

    ``parseTreeSitter`` yields ``parse``, ``tree``, ``sitter``; ``read_env``
    yields ``read``, ``env``. The originals are kept, so an exact identifier
    still matches an exact identifier.
    """


def build_tsquery(text: str) -> str:
    """Build the tsquery text, using ``websearch_to_tsquery`` semantics.

    ``websearch_to_tsquery`` is used rather than ``to_tsquery`` because a user
    query containing ``&``, ``|``, ``!`` or an unbalanced quote makes the latter
    raise a syntax error, and a search box is not a place to hand a parser
    error to the caller.
    """


async def refresh_corpus_stats(pool: AsyncConnectionPool, repository_id: UUID) -> None:
    """Recompute both statistics tables for one repository in one transaction."""
```

The ordering tiebreak on `sc.id` is deliberate: without it two chunks with identical scores swap
places between runs and the evaluation harness reports noise as a regression.

### Files

- CREATE `db/migrations/<timestamp>_bm25_corpus_stats.sql` - both tables, with a `migrate:down` that
  drops them
- CREATE `services/brain/src/brain/retrieval/bm25.py`
- CREATE `services/brain/src/brain/retrieval/sql/bm25.sql`
- CREATE `services/brain/tests/retrieval/test_bm25_terms.py` - term expansion and tsquery building,
  no database
- CREATE `services/brain/tests/retrieval/test_bm25_retriever.py` - marked `integration`
- MODIFY `services/brain/src/brain/retrieval/__init__.py` - register `bm25` on the process registry

### Acceptance Criteria

- [ ] A query for an exact identifier returns the chunk defining that identifier at rank 1 on the fixture repository
- [ ] A query containing `&`, `|`, `!` or an unbalanced double quote returns results rather than raising a tsquery syntax error
- [ ] `expand_identifier_terms` returns both `readEnv` and its parts, so a camel case query matches a snake case codebase and the reverse
- [ ] A rare identifier outranks a chunk that matches only a common word such as `client`, on a fixture where the common word appears in most chunks
- [ ] A long boilerplate chunk containing the query term once does not outrank a short chunk containing it once
- [ ] Results are restricted to `query.repository_id`, with no chunk from another repository at any rank
- [ ] When no `chunk_corpus_stats` row exists for the repository, `retrieve` returns an empty result with `diagnostics["reason"] == "corpus_stats_missing"` rather than raising, so hybrid fusion degrades to the other strategies
- [ ] Two identical calls return chunks in the same order, including for tied scores
- [ ] `refresh_corpus_stats` run twice in a row leaves the statistics tables unchanged
- [ ] `EXPLAIN` of the candidate stage shows `chunks_tsv_idx` in use rather than a sequential scan

### Required Tests

- `ranks the defining chunk first for an exact identifier query`
- `survives a query containing tsquery operator characters`
- `expands camel case and snake case identifiers in both directions`
- `prefers a rare term over a term present in most chunks`
- `does not let a long chunk outrank a short one on a single match`
- `never returns a chunk from another repository`
- `returns an empty result when corpus statistics are missing`
- `orders tied scores deterministically`
- `is idempotent when corpus statistics are refreshed twice`
- `uses the full text index for candidate selection`

### Performance Budget

p95 under 60 ms for a five-term query over 100,000 chunks in one repository with
`candidate_limit = 500`, measured on the CI runner by the integration test with
`EXPLAIN (ANALYZE, BUFFERS)` recorded in the pull request. `chunk_term_stats` stays under 40 MB per
100,000 chunks. `refresh_corpus_stats` completes in under 20 s for 100,000 chunks. The epic's
250 ms p95 at one million chunks is measured end to end by the harness, not here.

### Out of Scope

- Do not alter `content_tsv`, `chunks_tsv_idx`, or anything else in #25's migration; the query side
  compensates for the tokenisation instead
- Do not add a custom text search configuration or dictionary
- Do not wire `refresh_corpus_stats` into the ingestion worker; that is the worker's issue
- Do not implement fusion, reranking, or a hybrid entry point here
- Do not add `pg_search`, `rum`, or any other extension

### Dependencies

Blocked by #25, and by the protocol in
`docs/issues/epic-4-retrieval/010-retriever-protocol-and-registry.md`.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/retrieval -v
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
