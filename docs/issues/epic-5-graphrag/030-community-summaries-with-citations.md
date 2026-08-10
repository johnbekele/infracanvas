---
title: '[brain] Hierarchical community summaries where every claim is cited'
labels: tier:2, size:l, area:brain, area:db, epic:5-graphrag
---

### Epic

#6

### Context

Communities are sets of node identifiers, which is not something a user can read. This issue turns
each one into a short description of what that part of the system does, and it is the point in the
pipeline where a language model first writes text that a user will act on. The design question is
therefore not how to prompt well; it is what stops a plausible sentence about code that does not
exist from reaching someone who is about to provision infrastructure based on it.

The answer is that a claim without a resolvable `file:line` citation is not a summary, it is a
draft that failed. The model is asked for structured claims, each with the file and line range it
came from, and every citation is checked against the run's own files before anything is stored: the
path must exist in the run, the line range must be inside that file, and it must fall within the
span of a node belonging to the community being summarised. A claim that fails is dropped; if more
than a fifth of the claims in a summary fail, the whole summary is retried once with the offending
citations quoted back, and a second failure stores the summary with status `rejected`, which the
retrieval path never reads.

The rejected alternative is post-hoc attribution: let the model write prose, then embed each
sentence and staple on the nearest chunk. That always succeeds, which is exactly what is wrong with
it. The citation it produces is the chunk most similar to the sentence, not the chunk the sentence
came from, so a fabricated claim gets a citation that looks right and points at innocent code. A
citation that cannot fail is not evidence.

Summarisation is bottom-up because prompts must stay bounded. A level 0 community is summarised
from its members' chunk text; a level 1 community is summarised from its children's summaries, not
from their code. Concatenating raw source up the hierarchy overflows any context window by the
second level on a real repository, and truncating it silently drops whichever module sorted last.

The model is reached through a narrow protocol with a recorded-fixture implementation, so the test
suite never makes a network call and a prompt change shows up as a diff in a fixture rather than as
a flaky test. Credentials and model choice come from the bring-your-own-key settings in #61; this
issue reads that configuration and does not invent its own.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TYPE community_summary_status AS ENUM ('valid', 'rejected');

CREATE TABLE graph_community_summaries (
  community_id  uuid PRIMARY KEY REFERENCES graph_communities (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES ingestion_runs (id) ON DELETE CASCADE,
  title         text NOT NULL,
  summary       text NOT NULL,
  -- [{ "text": ..., "citations": [{ "path": ..., "start_line": n, "end_line": n }] }]
  claims        jsonb NOT NULL,
  status        community_summary_status NOT NULL,
  model         text NOT NULL,
  rejected_claims jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(claims) = 'array' AND jsonb_array_length(claims) > 0)
);

-- Retrieval reads valid summaries for one repository and never the rejected
-- ones, so the partial index is the access path.
CREATE INDEX graph_community_summaries_valid_idx
  ON graph_community_summaries (repository_id)
  WHERE status = 'valid';
```

```python
# services/brain/src/brain/graphrag/types.py
@dataclass(frozen=True, slots=True)
class Citation:
    path: str
    start_line: int
    end_line: int


@dataclass(frozen=True, slots=True)
class Claim:
    text: str
    citations: tuple[Citation, ...]


@dataclass(frozen=True, slots=True)
class CommunitySummary:
    community_id: UUID
    title: str
    summary: str
    claims: tuple[Claim, ...]
    status: Literal["valid", "rejected"]
    model: str
    rejected_claims: tuple[RejectedClaim, ...]


@dataclass(frozen=True, slots=True)
class RejectedClaim:
    text: str
    reason: Literal["uncited", "unknown_path", "line_out_of_range", "outside_community"]
```

```python
# services/brain/src/brain/graphrag/llm.py
class LlmClient(Protocol):
    """Structural, so the recorded fixture double is not a subclass of anything."""

    @property
    def model(self) -> str: ...

    async def complete_json(self, prompt: str, *, max_output_tokens: int) -> str: ...
```

```python
# services/brain/src/brain/graphrag/validation.py
UNCITED_CLAIM_TOLERANCE: Final = 0.2


class CitationIndex:
    """Line counts per path and node spans per community, for one run.

    Loaded once per repository rather than queried per claim: validating a
    thousand summaries one round trip at a time is slower than the model call
    it is checking.
    """

    def validate(self, claim: Claim, community_id: UUID) -> RejectedClaim | None: ...


def partition_claims(
    claims: Sequence[Claim], community_id: UUID, index: CitationIndex
) -> tuple[tuple[Claim, ...], tuple[RejectedClaim, ...]]:
    """Split into claims that survive validation and those that do not."""
```

```python
# services/brain/src/brain/graphrag/summarise.py
MAX_PROMPT_TOKENS: Final = 6000
MAX_CONCURRENT_CALLS: Final = 8


async def summarise_community(
    community_id: UUID,
    level: int,
    client: LlmClient,
    index: CitationIndex,
    pool: AsyncConnectionPool,
) -> CommunitySummary:
    """Summarise one community, retrying once when too many claims fail.

    Level 0 reads member chunk text; higher levels read the summaries of the
    child communities and never the code again.
    """


async def summarise_run(
    run_id: UUID, client: LlmClient, pool: AsyncConnectionPool
) -> SummaryReport:
    """Summarise every community of a run, lowest level first.

    Members are trimmed by degree until the prompt fits MAX_PROMPT_TOKENS, and
    the trim is recorded on the summary rather than left implicit.
    """
```

### Files

- CREATE `db/migrations/<timestamp>_community_summaries.sql`
- CREATE `services/brain/src/brain/graphrag/__init__.py`
- CREATE `services/brain/src/brain/graphrag/types.py`
- CREATE `services/brain/src/brain/graphrag/llm.py`
- CREATE `services/brain/src/brain/graphrag/prompts.py`
- CREATE `services/brain/src/brain/graphrag/validation.py`
- CREATE `services/brain/src/brain/graphrag/summarise.py`
- CREATE `services/brain/tests/graphrag/__init__.py`
- CREATE `services/brain/tests/graphrag/fixtures/` - recorded model responses, including a
  fabricated-citation response
- CREATE `services/brain/tests/graphrag/test_validation.py`
- CREATE `services/brain/tests/graphrag/test_summarise.py`
- CREATE `services/brain/tests/graphrag/test_summaries_db.py` - marked `integration`

### Acceptance Criteria

- [ ] A claim with no citations is rejected with reason `uncited` and never stored as part of a valid summary
- [ ] A citation naming a path absent from the run is rejected with reason `unknown_path`
- [ ] A citation whose `end_line` exceeds the file's line count is rejected with reason `line_out_of_range`
- [ ] A citation resolving to a real file outside the community's member spans is rejected with reason `outside_community`
- [ ] A response where more than 20% of claims fail validation triggers exactly one retry, and the retry prompt quotes the rejected citations
- [ ] A second failing response is stored with status `rejected` and is excluded by the query retrieval uses
- [ ] A model response that is not valid JSON is retried once and then stored as `rejected`, rather than raising out of `summarise_run`
- [ ] A level 1 summary is produced from its children's summaries, verified by the recorded prompt containing no source code
- [ ] Prompts stay under `MAX_PROMPT_TOKENS`, with trimmed members named on the summary
- [ ] `summarise_run` makes at most one model call per community in the happy path, counted on the fixture client
- [ ] Summarising a run twice with the same recorded responses produces identical stored rows
- [ ] The whole test suite passes with no network access

### Required Tests

- `rejects a claim with no citation`
- `rejects a citation to a file that is not in the run`
- `rejects a citation past the end of the file`
- `rejects a citation outside the community being summarised`
- `retries once when too many claims fail validation`
- `stores a rejected summary after a second failure`
- `treats an unparseable model response as a failed attempt`
- `builds a higher level summary from child summaries rather than source`
- `trims members to fit the prompt budget and records the trim`
- `makes one model call per community when validation passes`
- `excludes rejected summaries from the retrieval query`

### Performance Budget

Validation costs under 2 ms per summary of twenty claims, measured with `time.perf_counter` over
1000 iterations, so it is negligible against the model call it guards. `CitationIndex` for a
repository of 20,000 files loads in two queries and holds under 50 MB. Summarisation runs at most
`MAX_CONCURRENT_CALLS` model calls at once, so a 2000-community repository is bounded by the
provider's rate limit rather than by unbounded fan-out.

### Out of Scope

- Do not add a model provider SDK to `services/brain`; `LlmClient` is the boundary and the concrete
  client comes from #61
- Do not implement retrieval over summaries; that is
  `docs/issues/epic-5-graphrag/040-graph-expanded-retrieval.md`
- Do not change community detection to make summaries easier to write
- Do not add an evaluation of summary quality beyond citation validity
- Do not add an HTTP endpoint, and do not modify `brain/app.py`

### Dependencies

Blocked by #61, and by `docs/issues/epic-5-graphrag/020-leiden-communities.md` for the community
tables. Also depends on #25 for the chunk text a level 0 summary reads.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/graphrag -v
uv run --directory services/brain pytest tests/graphrag -m integration -v
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
