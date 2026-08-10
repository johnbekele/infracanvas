---
title: '[brain] Dense retriever over the halfvec HNSW index'
labels: tier:2, size:m, area:brain, epic:4-retrieval
---

### Epic

#5

### Context

The dense half of hybrid retrieval answers the queries BM25 cannot: "where is rate limiting
handled", asked of a codebase that never uses the word "rate". It reads the `chunk_embeddings`
table and the `halfvec` HNSW index created in #25, and almost all the difficulty is in two details
that are easy to get wrong and silent when wrong.

The first is `hnsw.ef_search`. It is a session variable, and the brain runs on a pooled connection,
so setting it with a plain `SET` leaves the value on the connection for whichever unrelated request
gets it next. That is a bug that never appears in a single-connection test and shows up in
production as latency that depends on what the previous caller asked for. It is therefore always
`SET LOCAL` inside the transaction that runs the query. The value itself trades recall against
latency along a curve that is steep below the limit and flat well above it: below `limit` pgvector
simply returns fewer rows than asked for, and past roughly four times `limit` the recall gain per
millisecond stops being worth paying for. Hence `min(400, max(40, limit * 4))`, with the constants
recorded here so the harness can move them on evidence rather than taste.

The second is keeping the repository filter index-usable. HNSW is an approximate index over the
whole table, so `WHERE repository_id = $1` is applied to rows the index scan has already produced.
With one repository in the table this is invisible; with fifty it means a query for a small
repository walks the graph, discards nearly everything, and returns three rows when twenty were
requested. Two structural fixes were considered and rejected: a partial index per repository grows
without bound and has to be created at ingest time, and hash partitioning `chunk_embeddings` would
change #25's schema and multiply the index count by the partition count. The chosen fix is
pgvector's iterative index scan, `hnsw.iterative_scan = relaxed_order`, bounded by
`hnsw.max_scan_tuples`, which continues the scan until enough rows survive the filter. It is set
`LOCAL` for the same reason as `ef_search`, and the retriever reports in `diagnostics` when it hit
the scan bound, because a silently short result set is the failure this exists to prevent.

The query embedding is an input, not something this retriever produces. Embedding generation needs
the model runtime and the bring-your-own-key settings from #61, and putting it here would make the
retriever untestable without a model on disk.

Spec: `docs/DATABASE.md`

### Contract

```python
# services/brain/src/brain/retrieval/dense.py
EMBEDDING_DIMENSIONS: Final = 384
MIN_EF_SEARCH: Final = 40
MAX_EF_SEARCH: Final = 400
MAX_SCAN_TUPLES: Final = 20_000


class MissingQueryEmbeddingError(ValueError):
    """Raised when a dense query arrives without an embedding."""


def choose_ef_search(limit: int) -> int:
    """Return the ef_search for a requested result count.

    Four times the limit, clamped to [MIN_EF_SEARCH, MAX_EF_SEARCH]. The floor
    exists because pgvector returns fewer than ``limit`` rows when ef_search is
    below it; the ceiling exists because the recall curve is flat past it and
    the latency curve is not.
    """


@dataclass(frozen=True, slots=True)
class DenseRetriever:
    max_scan_tuples: int = MAX_SCAN_TUPLES

    @property
    def name(self) -> str:
        return "dense"

    async def retrieve(
        self, query: RetrievalQuery, pool: AsyncConnectionPool
    ) -> RetrievalResult:
        """Nearest neighbours by cosine distance within one repository.

        Raises MissingQueryEmbeddingError when ``query.embedding`` is None and
        ValueError when its length is not EMBEDDING_DIMENSIONS, both before
        touching the database.
        """
```

```sql
-- Inside one transaction. SET LOCAL, never SET: the connection is pooled and
-- the next caller must not inherit this tuning.
SET LOCAL hnsw.ef_search = {ef_search};
SET LOCAL hnsw.iterative_scan = relaxed_order;
SET LOCAL hnsw.max_scan_tuples = {max_scan_tuples};

SELECT c.id, c.file_id, f.path, c.start_line, c.end_line, c.symbol, c.kind, c.content,
       1 - (e.embedding <=> %(embedding)s::halfvec) AS similarity
FROM chunk_embeddings e
JOIN chunks c ON c.id = e.chunk_id
JOIN files f ON f.id = c.file_id
WHERE e.repository_id = %(repository_id)s
ORDER BY e.embedding <=> %(embedding)s::halfvec
LIMIT %(limit)s;
```

`SET LOCAL` will not take a bound parameter, so the two integers are interpolated. They are produced
by `choose_ef_search` and by a validated `max_scan_tuples`, and they are rendered through
`psycopg.sql.Literal` rather than an f-string, so the statement cannot be reached with anything but
an integer.

The `ORDER BY` expression must stay exactly `e.embedding <=> $embedding::halfvec`. Wrapping it,
casting to `vector`, or ordering by the `1 - distance` similarity alias all stop matching
`halfvec_cosine_ops` and turn the query into a sequential scan that still returns correct rows,
which is why the plan is asserted in a test rather than eyeballed once.

### Files

- CREATE `services/brain/src/brain/retrieval/dense.py`
- CREATE `services/brain/src/brain/retrieval/sql/dense.sql`
- CREATE `services/brain/tests/retrieval/test_dense_ef_search.py` - `choose_ef_search`, no database
- CREATE `services/brain/tests/retrieval/test_dense_retriever.py` - marked `integration`
- MODIFY `services/brain/src/brain/retrieval/__init__.py` - register `dense` on the process registry

### Acceptance Criteria

- [ ] `choose_ef_search` never returns a value below the requested limit, including for a limit of 200
- [ ] A query with `embedding` unset raises `MissingQueryEmbeddingError` before opening a connection
- [ ] A query whose embedding has 512 values raises `ValueError` naming the expected dimension
- [ ] After a dense query completes, a subsequent query on the same pooled connection sees the default `hnsw.ef_search`, verified by reading `current_setting`
- [ ] `EXPLAIN` shows an index scan on `chunk_embeddings_hnsw_idx` rather than a sequential scan
- [ ] With ten repositories in the table, a query against the smallest still returns the full requested number of rows
- [ ] No chunk from another repository appears at any rank
- [ ] `diagnostics` reports the `ef_search` used and whether the scan bound was reached
- [ ] Results are ordered by descending similarity, and `score` is the cosine similarity rather than the distance
- [ ] A repository with no embeddings returns an empty result rather than raising

### Required Tests

- `clamps ef search to at least the requested limit`
- `clamps ef search to the configured ceiling`
- `raises before connecting when the query has no embedding`
- `rejects an embedding of the wrong dimension`
- `does not leak ef search onto the pooled connection`
- `uses the hnsw index rather than a sequential scan`
- `returns a full result set for a small repository among many`
- `never returns a chunk from another repository`
- `reports the ef search it used in diagnostics`
- `returns an empty result for a repository with no embeddings`

### Performance Budget

p95 under 80 ms for `limit = 20` over 100,000 chunks at the `ef_search` chosen by
`choose_ef_search`, measured on the CI runner with `EXPLAIN (ANALYZE, BUFFERS)` and recorded in the
pull request. Recall at 20 against exact nearest neighbours, computed by disabling the index scan
with `SET LOCAL enable_indexscan = off`, is at least 0.95 on the fixture corpus.

### Out of Scope

- Do not generate query embeddings, and do not add a model dependency to `services/brain`
- Do not change `m`, `ef_construction`, or the index definition from #25
- Do not add partitioning or per-repository partial indexes
- Do not implement reranking or fusion; the dense list is one input to fusion
- Do not add a fallback to brute force scanning when the index is missing

### Dependencies

Blocked by #25, and by the protocol in
`docs/issues/epic-4-retrieval/010-retriever-protocol-and-registry.md`.

### Verification

```bash
pnpm db:migrate
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/retrieval -v
psql "$DATABASE_URL" -c "SHOW hnsw.iterative_scan"
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
