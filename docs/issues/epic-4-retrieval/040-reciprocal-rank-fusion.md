---
title: '[brain] Reciprocal rank fusion across lexical, dense, and graph candidates'
labels: tier:2, size:m, area:brain, epic:4-retrieval
---

### Epic

#5

### Context

Three retrievers now return three ranked lists whose scores mean different things: BM25 returns an
unbounded sum that depends on the corpus, the dense retriever returns a cosine similarity in a
narrow band near the top of its range, and graph expansion returns a hop-weighted number invented
for the purpose. Something has to combine them into one list.

The obvious combiner is score normalisation: min-max each list into [0, 1], multiply by a weight,
add. It is rejected for one specific reason. Min-max over a truncated top-k list is not a property
of the document, it is a property of the list, so the same chunk's normalised score changes when an
unrelated chunk enters or leaves the window. As a repository grows, results reorder without any
underlying relevance changing, which makes both the evaluation harness and any cached answer
untrustworthy. Z-score normalisation has the same defect with more arithmetic, and both require
per-corpus weight tuning that nobody will redo for each user's codebase.

Reciprocal rank fusion reads only ranks. A document at rank r contributes `1 / (k + r)`, summed
across the lists that returned it, with `k = 60` from Cormack's original evaluation. It needs no
tuning, is invariant to how the underlying scores are scaled, and treats a retriever that fails as
simply absent rather than as a column of zeroes that drags everything down.

The price is real and worth stating: RRF throws away confidence. A retriever that is certain about
its top hit and one that is weakly guessing contribute identically at rank 1. The escape hatch is a
per-retriever weight multiplying that retriever's contribution, defaulting to 1.0 for the lexical
and dense lists and 0.5 for graph expansion, since expansion is a recall device rather than a
precision one. Weights are constants in one place, and the harness is what is allowed to change
them.

Fusion also owns concurrency and failure. The three retrievers run together under `asyncio.gather`
because their latencies overlap almost entirely, and each is given its own timeout: one strategy
degrading must not take the p95 with it. A retriever that raises or times out is dropped, recorded
in `diagnostics`, and the fused list is built from the rest. Returning fewer, worse results is a
better answer than an exception, and hiding the degradation is worse than both.

Spec: `docs/DATABASE.md`

### Contract

```python
# services/brain/src/brain/retrieval/fusion.py
RRF_K: Final = 60
DEFAULT_WEIGHTS: Final[Mapping[str, float]] = {"bm25": 1.0, "dense": 1.0, "graph": 0.5}
DEFAULT_RETRIEVER_TIMEOUT_S: Final = 2.0


@dataclass(frozen=True, slots=True)
class FusedChunk:
    chunk: RetrievedChunk
    score: float
    # retriever name -> the rank it placed this chunk at. Kept because "why is
    # this here" is the first question asked of any hybrid result.
    contributions: Mapping[str, int]


def reciprocal_rank_fusion(
    results: Sequence[RetrievalResult],
    *,
    limit: int,
    k: int = RRF_K,
    weights: Mapping[str, float] | None = None,
) -> tuple[FusedChunk, ...]:
    """Fuse ranked lists by reciprocal rank.

    score(chunk) = sum over lists of weight[list] / (k + rank_in_list)

    Chunks are identified by ``chunk_id``; the representative ``RetrievedChunk``
    is taken from the list that ranked it highest. Ties break on ``chunk_id`` so
    that the output is a function of the inputs alone.
    """


@dataclass(frozen=True, slots=True)
class HybridRetriever:
    members: tuple[str, ...] = ("bm25", "dense", "graph")
    weights: Mapping[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))
    k: int = RRF_K
    timeout_s: float = DEFAULT_RETRIEVER_TIMEOUT_S
    # Each member is asked for more than the caller wants, because a chunk
    # ranked 30th by one retriever and 2nd by another belongs in a top ten.
    overfetch: int = 3
    registry: RetrieverRegistry = REGISTRY

    @property
    def name(self) -> str:
        return "hybrid"

    async def retrieve(
        self, query: RetrievalQuery, pool: AsyncConnectionPool
    ) -> RetrievalResult:
        """Run every member concurrently and fuse what came back.

        A member that raises or exceeds ``timeout_s`` is logged, added to
        ``diagnostics["failed"]``, and excluded. When every member fails the
        result is empty rather than an exception, and ``diagnostics["failed"]``
        names all of them.
        """
```

`HybridRetriever` is itself a `Retriever` and registers under `hybrid`, so the harness scores it
through exactly the same path as the strategies it composes, and a fusion of a fusion is possible
without a special case.

### Files

- CREATE `services/brain/src/brain/retrieval/fusion.py`
- CREATE `services/brain/src/brain/retrieval/hybrid.py`
- CREATE `services/brain/tests/retrieval/test_fusion.py` - pure ranking arithmetic, no database
- CREATE `services/brain/tests/retrieval/test_hybrid_retriever.py` - concurrency and failure
  handling with stub retrievers, plus one case marked `integration`
- MODIFY `services/brain/src/brain/retrieval/__init__.py` - register `hybrid` on the process
  registry

### Acceptance Criteria

- [ ] A chunk returned by two retrievers outranks a chunk returned by one at the same rank
- [ ] Rescaling every score in one input list by a factor of 1000 leaves the fused order unchanged
- [ ] Appending an unrelated chunk to the end of one input list does not reorder the chunks above it
- [ ] Two chunks with identical fused scores are ordered by `chunk_id`, identically on repeated runs
- [ ] A retriever raising an exception is excluded and named in `diagnostics["failed"]`, and the fused result still contains the other retrievers' chunks
- [ ] A retriever exceeding `timeout_s` is cancelled and does not delay the response past the timeout
- [ ] When all members fail, `retrieve` returns an empty result rather than raising
- [ ] Each member is asked for `limit * overfetch` results, not `limit`
- [ ] `contributions` names every retriever that returned the chunk together with its rank there
- [ ] Hybrid retrieval returns the defining chunk at rank 1 for the identifier queries in the golden set, where dense-only does not
- [ ] Member retrievers run concurrently: total elapsed time for three members each sleeping 100 ms is under 200 ms

### Required Tests

- `ranks a chunk found by two retrievers above one found by one`
- `is invariant to the scale of the underlying scores`
- `does not reorder results when an unrelated chunk joins one input list`
- `breaks ties deterministically`
- `drops a retriever that raises and reports it in diagnostics`
- `cancels a retriever that exceeds its timeout`
- `returns an empty result when every member fails`
- `asks each member for more results than the caller requested`
- `records the contributing rank from each retriever`
- `runs member retrievers concurrently rather than in sequence`

### Performance Budget

Fusion arithmetic over three lists of 60 chunks completes in under 2 ms, measured with
`time.perf_counter` over 1000 iterations. End to end, `HybridRetriever.retrieve` holds p95 under
250 ms at one million chunks in one repository, which is the epic's exit criterion and is measured
by the harness rather than asserted here.

### Out of Scope

- Do not add a cross-encoder or any model-based reranking stage; that is a separate strategy and can
  be registered as one
- Do not change the member retrievers to make fusion easier; if a list is wrong, fix it in its own
  issue
- Do not tune the default weights without the harness output that justifies the change
- Do not add caching of fused results
- Do not add an HTTP endpoint

### Dependencies

Blocked by the protocol in `docs/issues/epic-4-retrieval/010-retriever-protocol-and-registry.md`,
the lexical strategy in `docs/issues/epic-4-retrieval/020-bm25-retriever.md`, and the dense strategy
in `docs/issues/epic-4-retrieval/030-dense-retriever.md`. The `graph` member is optional until
`docs/issues/epic-5-graphrag/040-graph-expanded-retrieval.md` lands, and its absence from the
registry must be treated as a missing member rather than an error. Also depends on #25.

### Verification

```bash
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/retrieval -v
uv run --directory services/brain pytest tests/retrieval -m integration -v
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
