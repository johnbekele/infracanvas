---
title: '[brain] Graph-expanded retrieval feeding the fusion step'
labels: tier:2, size:m, area:brain, epic:5-graphrag
---

### Epic

#6

### Context

Lexical and dense retrieval both score a chunk on how much it resembles the query. That works when
the answer is written somewhere, and fails on the questions this product exists to answer. "What
happens when a checkout fails" is answered by a handler, the queue it publishes to, the consumer of
that queue, and the table the consumer writes, and only the first of those four contains any word
from the query. No amount of ranking recovers the other three, because they were never candidates.

Graph expansion makes them candidates. Seed chunks come from the lexical and dense lists, are
mapped to the graph nodes whose spans they overlap, expanded two hops along the extracted edges,
and mapped back to chunks. The result is a ranked list like any other, and it goes into reciprocal
rank fusion as a third input rather than being merged in specially. That is the point of the
registry: expansion is a retriever, and if it does not earn its place the harness says so and it is
weighted down or removed without touching the other two.

Expansion is bounded hard. Two hops, at most 200 expanded nodes, and edges ordered by kind weight
before truncation, because the third hop from a well-connected utility module reaches most of the
repository and turns a candidate list into the whole corpus. Ranking within the expansion is by
hop distance and edge kind, with a bonus for sharing a Leiden community with a seed: a two-hop
neighbour inside the same module is far more likely to be part of the answer than a two-hop
neighbour reached through a logging helper.

The traversal is a recursive CTE written in Python. #26 already has one in
`apps/api/src/lib/db/graph.ts`, and it is not reused, because the brain does not make HTTP calls to
the Express API to serve its own retrieval. The duplication is deliberate and is limited to one
query, so the two must agree on the properties that matter, which is why the depth bound and cycle
termination are tested here rather than assumed from #26.

Community summaries are used for ranking here and not returned as results. Mixing a summary and a
code chunk into one ranked list would mean two different things wearing the same type, and how a
summary is presented in an answer is the brain epic's decision, not this one's.

Spec: `docs/DATABASE.md`

### Contract

```python
# services/brain/src/brain/retrieval/graph.py
MAX_DEPTH: Final = 2
MAX_EXPANDED_NODES: Final = 200
SEED_LIMIT: Final = 20

# A caller reached through an import weighs less than one reached through a
# call; a heuristic edge weighs least of all.
EDGE_WEIGHTS: Final[Mapping[str, float]] = {
    "calls": 1.0,
    "extends": 0.9,
    "handles": 0.9,
    "imports": 0.6,
    "references": 0.5,
    "db_query": 0.5,
    "http_call": 0.5,
    "reads_env": 0.4,
}
SAME_COMMUNITY_BONUS: Final = 0.5


@dataclass(frozen=True, slots=True)
class GraphRetriever:
    seed_retriever: str = "dense"
    depth: int = MAX_DEPTH
    max_expanded_nodes: int = MAX_EXPANDED_NODES
    seed_limit: int = SEED_LIMIT
    registry: RetrieverRegistry = REGISTRY

    @property
    def name(self) -> str:
        return "graph"

    async def retrieve(
        self, query: RetrievalQuery, pool: AsyncConnectionPool
    ) -> RetrievalResult:
        """Expand a seed set through the code graph and return the neighbours
        as chunks.

        Seeds come from ``query.seed_node_ids`` when the caller supplied them,
        and otherwise from running ``seed_retriever``. Seed chunks themselves
        are excluded from the output: they are already in the list that
        produced them, and returning them again would inflate their fused score
        for no new evidence.
        """
```

```sql
-- Chunk to node: a chunk covers a node when they are in the same file and
-- their line spans overlap.
SELECT DISTINCT n.id
FROM graph_nodes n
JOIN chunks c ON c.file_id = n.file_id
WHERE c.id = ANY(%(chunk_ids)s)
  AND n.run_id = %(run_id)s
  AND n.start_line <= c.end_line
  AND n.end_line >= c.start_line;
```

```sql
-- Bounded breadth-first expansion. `visited` carries the path so a cycle
-- terminates, and depth is a literal bound rather than a hope.
WITH RECURSIVE expansion AS (
  SELECT n.id AS node_id, 0 AS hops, 1.0::real AS weight, ARRAY[n.id] AS visited
  FROM graph_nodes n
  WHERE n.id = ANY(%(seed_node_ids)s)
  UNION ALL
  SELECT next.id,
         e.hops + 1,
         e.weight * %(edge_weight)s,
         e.visited || next.id
  FROM expansion e
  JOIN graph_edges g
    ON (g.source_id = e.node_id OR g.target_id = e.node_id)
   AND g.run_id = %(run_id)s
  JOIN graph_nodes next
    ON next.id = CASE WHEN g.source_id = e.node_id THEN g.target_id ELSE g.source_id END
  WHERE e.hops < %(depth)s
    AND NOT next.id = ANY(e.visited)
)
SELECT node_id, min(hops) AS hops, max(weight) AS weight
FROM expansion
GROUP BY node_id
ORDER BY weight DESC, hops, node_id
LIMIT %(max_expanded_nodes)s;
```

```python
def expansion_score(hops: int, edge_weight: float, same_community: bool) -> float:
    """edge_weight / (1 + hops), plus SAME_COMMUNITY_BONUS when the neighbour
    shares a level 0 community with the seed it was reached from.

    Only the resulting order reaches fusion, which reads ranks and not scores.
    """
```

Ties break on `chunk_id`, so the list handed to fusion is a function of the database state alone.

### Files

- CREATE `services/brain/src/brain/retrieval/graph.py`
- CREATE `services/brain/src/brain/retrieval/sql/graph_expansion.sql`
- CREATE `services/brain/tests/retrieval/test_graph_scoring.py` - scoring arithmetic, no database
- CREATE `services/brain/tests/retrieval/test_graph_retriever.py` - marked `integration`
- CREATE `services/brain/src/brain/eval/golden/architecture_queries.md` - how the architecture
  category judgements were made
- MODIFY `services/brain/src/brain/retrieval/__init__.py` - register `graph` on the process registry
- MODIFY `services/brain/src/brain/eval/golden/queries.json` - add architecture-level queries with
  their judged spans

### Acceptance Criteria

- [ ] A chunk overlapping a node's span by one line maps to that node, and a chunk in another file with the same line range does not
- [ ] Expansion stops at `depth` hops, verified on a chain of five nodes where the fifth is not returned
- [ ] Expansion terminates on a cyclic graph rather than looping
- [ ] At most `max_expanded_nodes` nodes are returned, and the ones kept are the highest weighted
- [ ] Seed chunks are absent from the returned list
- [ ] A neighbour sharing a level 0 community with its seed outranks an equally distant neighbour that does not
- [ ] Results contain no chunk from another repository
- [ ] When the repository has no graph nodes for the run, the result is empty with `diagnostics["reason"] == "no_graph"` rather than an exception
- [ ] When the seed retriever returns nothing, no expansion query is issued
- [ ] The retriever satisfies `Retriever` and is resolvable from the registry as `graph`, so `HybridRetriever` needs no change to include it
- [ ] Hybrid retrieval including graph expansion improves recall@10 on the harness `architecture` category by at least 10 points over hybrid without it, with the harness output pasted into the pull request
- [ ] Adding graph expansion does not push hybrid p95 latency over the epic's 250 ms budget, measured by the harness

### Required Tests

- `maps a chunk to the node whose span it overlaps`
- `does not map a chunk to a node in another file`
- `stops expanding at the depth bound`
- `terminates on a cyclic graph`
- `keeps the highest weighted neighbours when truncating`
- `excludes the seed chunks from the expanded list`
- `prefers a neighbour in the same community`
- `never returns a chunk from another repository`
- `returns an empty result when the run has no graph`
- `issues no expansion query when the seed retriever finds nothing`
- `orders tied candidates deterministically`

### Performance Budget

p95 under 90 ms for 20 seeds at depth 2 on a graph of 100,000 nodes and 400,000 edges, measured on
the CI runner with `EXPLAIN (ANALYZE, BUFFERS)` recorded in the pull request. Expansion runs
concurrently with the other members inside `HybridRetriever`, so its budget is contained by the
epic's 250 ms end-to-end p95 rather than added to it.

### Out of Scope

- Do not return community summaries as retrieval results; they rank here and are rendered by the
  brain epic
- Do not raise `MAX_DEPTH` above 2 without harness evidence that recall improves more than latency
  costs
- Do not change `apps/api/src/lib/db/graph.ts`; the duplication of the traversal is deliberate
- Do not change the fusion weights from
  `docs/issues/epic-4-retrieval/040-reciprocal-rank-fusion.md` to make this retriever look better
- Do not add graph extraction, community detection, or summarisation; all three are upstream issues

### Dependencies

Blocked by #26, by `docs/issues/epic-4-retrieval/040-reciprocal-rank-fusion.md`, by
`docs/issues/epic-4-retrieval/050-evaluation-harness.md` for the recall measurement, and by
`docs/issues/epic-5-graphrag/020-leiden-communities.md` for the community bonus.

### Verification

```bash
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/retrieval -v
uv run --directory services/brain pytest tests/retrieval -m integration -v
uv run --directory services/brain python -m brain.eval.harness --retriever hybrid --k 10 --category architecture
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
