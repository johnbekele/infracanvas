---
title: '[brain] Retrieval evaluation harness with a committed golden query set'
labels: tier:2, size:l, area:brain, epic:4-retrieval
---

### Epic

#5

### Context

Every claim this epic makes is quantitative: hybrid beats dense-only on identifier queries, p95
retrieval stays under 250 ms at a million chunks, a new strategy can be scored without touching the
old ones. None of that is checkable by reading a diff, and "it looks better" is how retrieval
systems quietly regress for months. This issue builds the instrument that turns those claims into
numbers a reviewer can read.

The golden set lives in the repository rather than in a database or a hosted evaluation service.
Judgements are the expensive artefact here, they are reviewed like code, and their history is the
only record of why a query was ever considered answered by a particular file. A hosted service
would also make the harness unrunnable offline, which is the situation an agent picking up a
retrieval issue is usually in.

Judgements are stored as `path` plus a line range, not as chunk identifiers. Chunk ids are minted
per ingestion run, so a judgement keyed on them is invalid the first time chunking changes, and
chunking will change. A retrieved chunk counts as relevant when its line span overlaps a judged
span in the same file: overlap rather than containment, because a chunker that splits a function
one line differently should not score as a miss.

Metrics are computed here rather than pulled from a library. `scikit-learn` would bring a large
dependency for three short functions, and its nDCG expects a dense relevance matrix over a fixed
document universe, which does not describe a ranked list of ten chunks drawn from a million.
Percentiles use nearest-rank rather than `statistics.quantiles`, whose interpolation invents a
latency value that was never observed, and which behaves differently on small samples in a way that
makes run-to-run comparisons argue about nothing.

Peak resident memory is reported because the project's constraint is an ordinary laptop, and a
retrieval strategy that buys recall with two gigabytes of process memory has not made a trade
anyone agreed to. `ru_maxrss` is kilobytes on Linux and bytes on macOS, and normalising that is a
test rather than a comment.

Spec: `docs/DATABASE.md`

### Contract

```python
# services/brain/src/brain/eval/types.py
Category = Literal["identifier", "natural_language", "architecture"]


@dataclass(frozen=True, slots=True)
class RelevantSpan:
    path: str
    start_line: int
    end_line: int
    # 3 answers the question outright, 1 is useful context, 0 is judged
    # irrelevant and is kept so a known bad hit stays known.
    grade: int


@dataclass(frozen=True, slots=True)
class GoldenQuery:
    id: str
    text: str
    category: Category
    fixture: str  # the fixture repository this query is asked of
    relevant: tuple[RelevantSpan, ...]


@dataclass(frozen=True, slots=True)
class QueryOutcome:
    query_id: str
    category: Category
    recall_at_k: float
    ndcg_at_k: float
    reciprocal_rank: float
    latency_ms: float


@dataclass(frozen=True, slots=True)
class EvaluationReport:
    retriever: str
    k: int
    query_count: int
    recall_at_k: float          # macro average over queries
    ndcg_at_k: float
    mrr: float
    latency_p50_ms: float
    latency_p95_ms: float
    peak_rss_mb: float
    by_category: Mapping[Category, CategoryScores]
    outcomes: tuple[QueryOutcome, ...]

    def to_json(self) -> str: ...
    def to_markdown(self) -> str: ...
```

```python
# services/brain/src/brain/eval/metrics.py
def is_relevant(chunk: RetrievedChunk, spans: Sequence[RelevantSpan]) -> RelevantSpan | None:
    """Return the judged span this chunk overlaps in the same file, or None."""


def recall_at_k(ranked: Sequence[RetrievedChunk], spans: Sequence[RelevantSpan], k: int) -> float:
    """Fraction of spans with grade >= 1 hit by the first k results."""


def ndcg_at_k(ranked: Sequence[RetrievedChunk], spans: Sequence[RelevantSpan], k: int) -> float:
    """Graded gain (2**grade - 1) with log2 discount, over the ideal ordering."""


def reciprocal_rank(ranked: Sequence[RetrievedChunk], spans: Sequence[RelevantSpan]) -> float:
    """1 / rank of the first result with grade >= 2, else 0.0."""


def percentile(samples: Sequence[float], q: float) -> float:
    """Nearest-rank percentile. No interpolation: every value returned was
    actually measured."""


def peak_rss_mb() -> float:
    """Peak resident set size of this process, normalised across platforms."""
```

```python
# services/brain/src/brain/eval/harness.py
async def evaluate(
    retriever: Retriever,
    queries: Sequence[GoldenQuery],
    pool: AsyncConnectionPool,
    *,
    k: int = 10,
    repeats: int = 3,
) -> EvaluationReport:
    """Run every query ``repeats`` times, scoring the first run and taking the
    median latency of the rest, so that a cold cache is measured once rather
    than reported as the typical case."""


def compare(report: EvaluationReport, baseline: EvaluationReport, tolerance: float = 0.02) -> list[str]:
    """Return one line per metric that regressed beyond ``tolerance``."""


def main(argv: Sequence[str] | None = None) -> int:
    """`python -m brain.eval.harness --retriever hybrid --k 10 [--baseline PATH]
    [--category identifier] [--json OUT]`

    Exits 1 when --baseline is given and ``compare`` returns anything.
    """
```

The golden set is JSON, not YAML, so it needs no dependency the service does not already have:
`services/brain/src/brain/eval/golden/queries.json`, validated on load by a pydantic model, with at
least forty queries spread across the three categories and at least eight identifier queries, since
those are what the epic's exit criterion is measured on.

### Files

- CREATE `services/brain/src/brain/eval/__init__.py`
- CREATE `services/brain/src/brain/eval/types.py`
- CREATE `services/brain/src/brain/eval/metrics.py`
- CREATE `services/brain/src/brain/eval/harness.py`
- CREATE `services/brain/src/brain/eval/golden/queries.json`
- CREATE `services/brain/src/brain/eval/golden/README.md` - how to add a query and how a judgement
  is made
- CREATE `services/brain/tests/eval/__init__.py`
- CREATE `services/brain/tests/eval/test_metrics.py`
- CREATE `services/brain/tests/eval/test_golden_set.py`
- CREATE `services/brain/tests/eval/test_harness.py` - stub retriever, no database
- MODIFY `services/brain/pyproject.toml` - include the golden set in the wheel via
  `[tool.hatch.build.targets.wheel]`
- MODIFY `services/brain/README.md` - document how to run the harness

### Acceptance Criteria

- [ ] `recall_at_k` counts a chunk as a hit when its line span overlaps a judged span by one line, and not when it is in a different file with the same range
- [ ] `ndcg_at_k` returns 1.0 when the ranking matches the ideal graded ordering and less than 1.0 when two graded results are swapped
- [ ] `reciprocal_rank` returns 0.0, rather than raising or returning infinity, when nothing relevant is retrieved
- [ ] `percentile` returns an element of the input sample for any q, and handles a single-element sample
- [ ] `peak_rss_mb` returns the same order of magnitude on Linux and macOS for the same process
- [ ] The harness resolves the retriever by name through the registry, so scoring a newly registered strategy requires no change to `harness.py`
- [ ] Every judged path in the golden set exists in its fixture repository, checked by a test that does not need a database
- [ ] The report prints a markdown table with one row per retriever run and per-category breakdowns
- [ ] `--baseline` exits non-zero when recall@10 drops by more than the tolerance and zero when it improves
- [ ] Two runs of the harness against the same corpus and retriever produce identical recall, nDCG, and MRR
- [ ] Hybrid scores higher recall@10 than dense-only on the `identifier` category, recorded in the pull request

### Required Tests

- `counts an overlapping chunk as a hit`
- `does not count the same line range in a different file`
- `scores a perfect ranking as one and a swapped ranking below it`
- `returns zero reciprocal rank when nothing relevant is found`
- `returns a measured sample rather than an interpolated percentile`
- `normalises peak memory across platforms`
- `scores a retriever that was registered at test time`
- `fails when a golden judgement points at a path that does not exist`
- `reports identical metrics on two runs over the same corpus`
- `exits non zero when compared against a better baseline`

### Performance Budget

Harness overhead per query, measured against a stub retriever that returns a fixed list, stays under
1 ms, so the latency it reports is the retriever's rather than its own. A full run of forty queries
at three repeats against three strategies completes in under 5 minutes on the CI runner. The
harness holds one query's results in memory at a time, so its own peak RSS stays under 200 MB and
does not distort the figure it reports for the retriever.

### Out of Scope

- Do not add `scikit-learn`, `ranx`, `pytrec_eval`, or any other evaluation dependency
- Do not build the fixture corpora here; the harness reads whatever the ingestion pipeline produced,
  and the fixture repositories are pinned by the golden set README
- Do not wire the harness into a CI gate in this issue; that needs a stable baseline first
- Do not modify any retriever to improve its score
- Do not add answer quality or generation metrics; this measures retrieval only

### Dependencies

Blocked by #25, by the protocol in
`docs/issues/epic-4-retrieval/010-retriever-protocol-and-registry.md`, and by at least the dense
strategy in `docs/issues/epic-4-retrieval/030-dense-retriever.md` so there is something to score.

### Verification

```bash
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/eval -v
uv run --directory services/brain python -m brain.eval.harness --retriever dense --k 10
uv run --directory services/brain python -m brain.eval.harness --retriever hybrid --k 10 --category identifier
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
