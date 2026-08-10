---
title: '[brain] Retriever protocol and strategy registry'
labels: tier:2, size:m, area:brain, epic:4-retrieval
---

### Epic

#5

### Context

This epic adds four retrieval strategies and will add more. Whether that is cheap or expensive is
decided now, by whether a strategy is a plugin or a branch in a function everybody edits.

The obvious shape is one `retrieve(query, strategy)` coroutine with an `if strategy == "bm25"`
ladder. It is rejected because every new strategy then edits the same function, the evaluation
harness has to know the closed set of names in advance, and an experiment cannot be run from a test
without shipping it. An abstract base class was also rejected: inheritance would force every
retriever to be a class in a fixed hierarchy, whereas a `Protocol` is satisfied structurally, so a
frozen dataclass, a closure wrapped in a small adapter, or a test double all qualify without
importing anything from this module. mypy is in strict mode here, so the structural check is
enforced at type-check time rather than discovered at runtime.

Registration is explicit rather than discovered. Import-side-effect registration, or entry points
declared in `pyproject.toml`, would mean the set of available retrievers depends on which modules
happened to be imported first, which is unreproducible in a test process and awkward to reason
about when the harness reports that a strategy "does not exist". A registry is an object with a
`register` method, and there is one process-wide instance that application code uses; tests
construct their own instance so that registering a fake never leaks into the next test.

Retriever names are plain strings, not a `Literal` union. A closed union would give better
autocompletion and would defeat the entire point: adding a strategy would again mean editing a
shared type.

Retrievers are stateless and take the connection pool per call rather than holding one. A retriever
that captured a pool at construction could not be registered before the pool exists, and would
bind the process to a single database, which rules out evaluating one strategy against two corpora
in the same run.

Spec: `docs/DATABASE.md`

### Contract

```python
# services/brain/src/brain/retrieval/types.py
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final
from uuid import UUID

MAX_LIMIT: Final = 200


@dataclass(frozen=True, slots=True)
class RetrievalQuery:
    """One retrieval request.

    Frozen so that a fusion strategy can hand the same query to several
    retrievers concurrently without one of them mutating it for the next.
    """

    repository_id: UUID
    text: str
    limit: int = 20
    run_id: UUID | None = None
    languages: tuple[str, ...] = ()
    embedding: tuple[float, ...] | None = None
    seed_node_ids: tuple[UUID, ...] = ()

    def __post_init__(self) -> None:
        """Raise ``ValueError`` for a blank query or a limit outside 1..MAX_LIMIT."""


@dataclass(frozen=True, slots=True)
class RetrievedChunk:
    chunk_id: UUID
    file_id: UUID
    path: str
    start_line: int
    end_line: int
    symbol: str | None
    kind: str
    content: str
    # Retriever-native and NOT comparable across retrievers: a BM25 score of 8.1
    # and a cosine similarity of 0.81 say nothing about each other.
    score: float
    # One-based position within this retriever's own result list. This is the
    # only quantity fusion is allowed to read.
    rank: int
    retriever: str


@dataclass(frozen=True, slots=True)
class RetrievalResult:
    query: RetrievalQuery
    retriever: str
    chunks: tuple[RetrievedChunk, ...]
    elapsed_ms: float
    # Whatever the strategy needs to explain itself: ef_search used, candidate
    # counts, hop counts. Reported by the harness, never branched on.
    diagnostics: Mapping[str, object] = field(default_factory=dict)


def rank_chunks(chunks: Sequence[RetrievedChunk]) -> tuple[RetrievedChunk, ...]:
    """Assign one-based ranks in list order, replacing any existing rank."""
```

```python
# services/brain/src/brain/retrieval/protocol.py
from typing import Protocol, runtime_checkable

from psycopg_pool import AsyncConnectionPool


@runtime_checkable
class Retriever(Protocol):
    """A retrieval strategy.

    Implementations are stateless. Anything that varies per request belongs in
    ``RetrievalQuery``; anything that varies per deployment is constructor
    configuration supplied by the factory that registered it.
    """

    @property
    def name(self) -> str: ...

    async def retrieve(
        self, query: RetrievalQuery, pool: AsyncConnectionPool
    ) -> RetrievalResult: ...
```

```python
# services/brain/src/brain/retrieval/registry.py
RetrieverFactory = Callable[[], Retriever]


class UnknownRetrieverError(KeyError):
    """Raised when a name that was never registered is requested."""


class DuplicateRetrieverError(ValueError):
    """Raised when a name is registered twice."""


class RetrieverRegistry:
    def register(self, name: str, factory: RetrieverFactory) -> None: ...
    def get(self, name: str) -> Retriever: ...
    def names(self) -> tuple[str, ...]: ...  # sorted, so output is stable


REGISTRY: Final = RetrieverRegistry()


def register(name: str) -> Callable[[RetrieverFactory], RetrieverFactory]:
    """Decorator form for the process-wide registry."""
```

`UnknownRetrieverError.args[0]` carries the requested name and the sorted list of registered names,
because the caller is usually a command line argument that was mistyped.

### Files

- CREATE `services/brain/src/brain/retrieval/__init__.py` - re-exports `Retriever`, the query and
  result types, `REGISTRY`, and `register`
- CREATE `services/brain/src/brain/retrieval/types.py`
- CREATE `services/brain/src/brain/retrieval/protocol.py`
- CREATE `services/brain/src/brain/retrieval/registry.py`
- CREATE `services/brain/tests/retrieval/__init__.py`
- CREATE `services/brain/tests/retrieval/test_types.py`
- CREATE `services/brain/tests/retrieval/test_registry.py`

### Acceptance Criteria

- [ ] A frozen dataclass with a `name` property and a matching `retrieve` coroutine satisfies `Retriever` under `mypy --strict` with no inheritance and no import from `protocol.py`
- [ ] Constructing a `RetrievalQuery` with an empty or whitespace-only `text` raises `ValueError`
- [ ] Constructing a `RetrievalQuery` with `limit` of 0 or above `MAX_LIMIT` raises `ValueError`
- [ ] `RetrievalQuery` and `RetrievedChunk` reject attribute assignment after construction
- [ ] `registry.get` on an unregistered name raises `UnknownRetrieverError` naming the registered alternatives, rather than returning `None`
- [ ] Registering an already-registered name raises `DuplicateRetrieverError` rather than replacing the existing factory
- [ ] `registry.get` returns a new instance per call, so one request cannot observe another's state
- [ ] `registry.names()` is sorted, so a harness report lists strategies in the same order on every run
- [ ] Registering a retriever on a locally constructed `RetrieverRegistry` leaves `REGISTRY` unchanged
- [ ] `rank_chunks` numbers from 1 and preserves the order it was given

### Required Tests

- `a structurally compatible object satisfies the retriever protocol`
- `rejects an empty query text`
- `rejects a limit above the maximum`
- `rejects mutation of a retrieval query after construction`
- `raises with the registered names when a strategy is unknown`
- `refuses to register the same name twice`
- `returns a fresh retriever instance on each lookup`
- `lists registered names in sorted order`
- `keeps a local registry isolated from the process wide one`

### Performance Budget

`RetrieverRegistry.get` completes in under 100 microseconds averaged over 10,000 iterations timed
with `time.perf_counter`, so that fusion calling it once per strategy per request is not measurable.
Importing `brain.retrieval` adds under 50 ms to process start, measured with
`uv run --directory services/brain python -X importtime -c "import brain.retrieval"`.

### Out of Scope

- Do not implement any concrete retriever; BM25, dense, graph, and fusion each have their own issue
- Do not add a FastAPI route, and do not touch `brain/app.py` or `brain/health.py`; the HTTP surface
  belongs to the brain epic
- Do not add query embedding generation; `RetrievalQuery.embedding` is supplied by the caller
- Do not add caching or a result store; a retriever is a pure function of query and database state

### Dependencies

Blocked by #25, which defines the `chunks` columns that `RetrievedChunk` mirrors.

### Verification

```bash
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/retrieval -v
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
