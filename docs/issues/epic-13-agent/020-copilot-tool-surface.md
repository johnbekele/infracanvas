---
title: '[brain] Copilot tool surface over the IR, shared by the agent and the MCP server'
labels: tier:2, size:l, area:brain, epic:13-agent
---

### Epic

#117

### Context

`services/brain` is a FastAPI health endpoint, a lazily opened connection pool and nothing else. The
only agent precedent in the repository is the profile agent in
`docs/issues/epic-6-brain/040-appprofile-agent-with-citations.md`, whose tools are registered as
`RunContext`-taking closures because there is exactly one caller. The copilot has two callers from the
start: the conversation loop in `040-conversation-run-loop.md`, and the MCP server in #118, which
exists precisely so that an editor can drive the same operations. If the tools are written as
pydantic-ai closures, #118 reimplements them against the same tables, and the two implementations
disagree about something small and load-bearing -- whether `propose_patch` writes, whether a stale
document is an error or a warning -- with no test that can see the disagreement.

So the tools are plain async functions taking a typed dependency object and a Pydantic argument model,
and pydantic-ai registration is a five-line adapter over each one. That inverts the usual pydantic-ai
layout deliberately: the framework becomes a caller of the tool surface rather than its owner, and
#118 imports the same six functions.

**`propose_patch` never mutates.** It builds an `IrPatch`, has it applied and priced in a sandbox by
the preview plane, records the result, and returns it. A rejected patch is returned as problems rather
than raised, because the useful next action is for the model to fix the operation order and try again,
and an exception per failure mode teaches an agent to stop trying. The alternative -- one
`edit_architecture(document)` tool -- makes the model the author of the document, which is the thing
`010-ir-patch-protocol.md` exists to prevent.

**`apply_patch` takes a proposal id, not JSON.** The reason is not tidiness: if the argument were a
patch document, then the model could propose one patch, have it priced and shown to the user, and then
apply different bytes, and nothing downstream would notice because both would validate. Taking an id
means the thing applied is the row whose preview the user read. It also refuses a proposal the user has
not accepted, returning `awaiting_user_acceptance`, so the model can hold the tool and still not
bypass the person paying for the architecture. Not registering the tool with the agent at all was the
other option, and it was rejected because the guard then lives in a tool list rather than in the
store, and #118's callers would need a second, unguarded path to apply anything.

**Proposals are a table, not process memory.** A turn streams over a connection that can drop, the
accept action arrives as a separate HTTP request minutes later, and the API restarts on deploy.
Keeping proposals in a dict keyed by conversation would make "accept" fail in exactly the situations
where a user has been thinking. The inverse patch is stored with the proposal, computed against the
same document, so reverting never depends on recomputing an inverse against a document that has since
moved.

One grounding limit has to be stated rather than papered over. `packages/core/src/analysis/
architecture.ts` produces `ArchitectureDecision` records with `evidence` file paths and a `confidence`,
but nothing persists them: `db/migrations/20260810121000_analyses.sql` stores only `profile jsonb`, and
the proposal is recomputed in the browser. So `explain_node` grounds its repository citations in the
stored `AppProfile` -- `dependencies[].sourcePath`, `components[].manifestPaths`, `components[]
.dockerfiles` -- and returns an empty list when nothing in the profile matches the node. Empty is the
correct answer there; a plausible path is the failure this epic cannot afford.

Spec: `docs/issues/epic-2-ir/010-architecture-ir-schema.md`

### Contract

```sql
-- db/migrations/<timestamp>_copilot_patch_proposals.sql
CREATE TYPE copilot_proposal_status AS ENUM (
  'proposed', 'accepted', 'applied', 'rejected', 'superseded'
);

CREATE TABLE copilot_patch_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id      uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- patchDigest() from packages/core: identifies the exact bytes the user was
  -- shown, so an applied patch can be proved to be the previewed one.
  patch_digest       text NOT NULL,
  based_on_ir_digest text NOT NULL,
  patch              jsonb NOT NULL,
  -- invertPatch() computed against the same document at proposal time. Stored
  -- rather than derived later, because later the document may have moved.
  inverse            jsonb NOT NULL,
  -- The document the preview plane produced and priced. Stored so that applying
  -- is a write of the exact bytes the user was shown a price for, and so that
  -- apply needs no second call into TypeScript to recompute it.
  patched_ir         jsonb NOT NULL,
  preview            jsonb NOT NULL,
  status             copilot_proposal_status NOT NULL DEFAULT 'proposed',
  -- The model's stated reason. Displayed; never parsed.
  rationale          text NOT NULL,
  applied_ir_digest  text,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- An applied row without the resulting digest cannot be audited or reverted.
  CHECK (status <> 'applied' OR applied_ir_digest IS NOT NULL),
  CHECK (status = 'proposed' OR decided_at IS NOT NULL)
);

CREATE INDEX copilot_patch_proposals_experiment_idx
  ON copilot_patch_proposals (experiment_id, created_at DESC);

-- The same edit proposed twice while the first is still open is the same
-- proposal, not two.
CREATE UNIQUE INDEX copilot_patch_proposals_open_idx
  ON copilot_patch_proposals (experiment_id, patch_digest)
  WHERE status = 'proposed';

CREATE TRIGGER copilot_patch_proposals_set_updated_at
  BEFORE UPDATE ON copilot_patch_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

```python
# services/brain/src/brain/copilot/deps.py
@dataclass
class CopilotDeps:
    experiment_id: UUID
    user_id: UUID
    pool: AsyncConnectionPool
    # The internal preview client from 030-patch-preview-deltas.md. Applies and
    # prices a patch; never writes.
    preview: PreviewClient
    # Every call the tool layer served this turn, appended by the layer itself.
    # 040 streams from this and the model cannot write to it.
    calls: list[ToolCall] = field(default_factory=list)


class ExperimentNotFoundError(LookupError):
    """No experiment with this id belongs to this user. Not distinguished from
    a wrong owner, because a distinct error would confirm the id exists."""


class ToolBudgetExceededError(RuntimeError):
    """The turn's tool call ceiling was reached. Raised by the runtime, not here."""
```

```python
# services/brain/src/brain/copilot/tools.py
MAX_COMPARE_OPTIONS = 4
MAX_EXPLAIN_EDGES = 40


class ArchitectureView(BaseModel):
    """The whole document plus an index of it. The index exists so a model can
    name a node without re-reading params it does not need."""

    ir: ArchitectureIr  # the generated Pydantic model from #78
    ir_digest: str
    region: str
    nodes: list[NodeSummary]  # id, kind, name, parent
    edges: list[EdgeSummary]  # id, kind, source, target
    monthly_usd: float | None  # baseline, None when nothing could be priced
    node_count: int


async def read_architecture(deps: CopilotDeps, args: ReadArchitectureArgs) -> ArchitectureView:
    """Read the experiment's current IR. Raises ExperimentNotFoundError."""


class ProposePatchArgs(BaseModel):
    ops: list[IrPatchOp] = Field(min_length=1, max_length=50)
    # One sentence for the diff card. Not parsed.
    summary: str = Field(min_length=1, max_length=200)
    # Why, in the model's own words, shown under the card.
    rationale: str = Field(min_length=1, max_length=2000)


class PatchProposal(BaseModel):
    proposal_id: UUID | None  # None when the patch was refused
    patch_digest: str
    based_on_ir_digest: str
    accepted: bool  # whether the patch is applicable, not whether a user agreed
    problems: list[PatchProblem]
    preview: PatchPreview | None
    touched_node_ids: list[str]


async def propose_patch(deps: CopilotDeps, args: ProposePatchArgs) -> PatchProposal:
    """Apply the ops in a sandbox, price the result, record the proposal.

    Writes exactly one row to copilot_patch_proposals and nothing to
    experiments. A patch that fails validation or a precondition returns
    accepted=False with the problems and writes no row.
    """


class ApplyPatchArgs(BaseModel):
    proposal_id: UUID


class ApplyOutcome(BaseModel):
    outcome: Literal[
        "applied",
        "already_applied",
        "awaiting_user_acceptance",
        "rejected_by_user",
        "stale",
    ]
    ir_digest_before: str | None
    ir_digest_after: str | None
    touched_node_ids: list[str]
    message: str


async def apply_patch(deps: CopilotDeps, args: ApplyPatchArgs) -> ApplyOutcome:
    """Write the proposal's stored patched_ir to experiments.ir.

    Refuses anything not in status 'accepted', and refuses a proposal whose
    based_on_ir_digest no longer matches the experiment, reporting 'stale'. The
    read of the experiment row, the digest comparison and the write happen in
    one transaction with the row locked, so two accepts cannot both apply
    against the same document.

    Nothing is recomputed here. The document written is the one the preview
    plane produced and priced, so "what was previewed is what was applied" is a
    property of the bytes rather than of two implementations agreeing.
    """


class NodeExplanation(BaseModel):
    node_id: str
    kind: str
    params: dict[str, str | int | float | bool | None]
    parent_chain: list[str]  # nearest first
    edges_in: list[EdgeSummary]
    edges_out: list[EdgeSummary]
    # Cost lines for this resource, each carrying the SKU its rate came from.
    cost_lines: list[CostLine]
    availability: AvailabilityEntry | None
    findings: list[RuleFinding]
    # Repository paths from the stored AppProfile that mention this node's
    # component or dependency. Empty when nothing matches; never inferred.
    evidence: list[FileCitation]


async def explain_node(deps: CopilotDeps, args: ExplainNodeArgs) -> NodeExplanation: ...


class OptionSpec(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    ops: list[IrPatchOp] = Field(min_length=1, max_length=50)


class CompareOptionsArgs(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    options: list[OptionSpec] = Field(min_length=2, max_length=MAX_COMPARE_OPTIONS)


class OptionComparison(BaseModel):
    question: str
    # One entry per option, in the order given, including the ones that failed.
    options: list[ComparedOption]  # label, accepted, problems, preview
    # The current architecture, so a comparison always has a do-nothing column.
    baseline_monthly_usd: float | None


async def compare_options(deps: CopilotDeps, args: CompareOptionsArgs) -> OptionComparison:
    """Price each option against the same document. Records no proposal: a
    comparison is a question, and a user cannot accept a column."""


class PriceChangeArgs(BaseModel):
    ops: list[IrPatchOp] = Field(min_length=1, max_length=50)


async def price_change(deps: CopilotDeps, args: PriceChangeArgs) -> PatchPreview:
    """The delta for a hypothetical, stored nowhere. This is the cheap tool the
    model is expected to use while thinking; propose_patch is the commitment."""
```

```python
# services/brain/src/brain/copilot/registry.py
@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    args_model: type[BaseModel]
    result_model: type[BaseModel]
    handler: Callable[[CopilotDeps, BaseModel], Awaitable[BaseModel]]
    # False for propose_patch, compare_options, price_change, read_architecture
    # and explain_node. Asserted by a test, so a future tool has to declare it.
    mutates: bool


# The one list. 040 registers from it, #118 serves from it, and a tool that is
# in neither place is in neither list.
COPILOT_TOOLS: tuple[ToolSpec, ...]
```

Every tool takes its scope from `CopilotDeps`, never from its arguments: there is no `experiment_id`
or `user_id` in any argument model, so a model cannot ask about somebody else's architecture by
guessing a UUID. The single SQL predicate is
`WHERE id = %(experiment_id)s AND user_id = %(user_id)s`, and a miss is
`ExperimentNotFoundError` whatever the reason.

That two-argument shape is the contract #118 binds to, and it is worth saying plainly because
`docs/issues/epic-14-mcp/030-mcp-architecture-tools.md` was written before this file existed and
sketches its wrappers calling `copilot.explain_node(experiment, node_id)`. The module path it expects,
`brain.copilot.tools`, is the one here; the call shape is `(deps, args)`. An MCP wrapper therefore
builds a `CopilotDeps` from its resolved principal and pool and a `ReadArchitectureArgs` or
`ExplainNodeArgs` from the values the client sent, which is construction rather than the argument
coercion that issue forbids, and its
`test_wrapper_signature_matches_the_copilot_signature` compares the wrapper's parameters against the
fields of the argument model rather than against positional scalars. `ReadArchitectureArgs` is also
where that issue's `view` and `max_bytes` belong when it lands, so the projection is one optional
field on a shared model rather than a second read path.

### Files

- CREATE `db/migrations/<timestamp>_copilot_patch_proposals.sql`
- CREATE `services/brain/src/brain/copilot/__init__.py`
- CREATE `services/brain/src/brain/copilot/deps.py`
- CREATE `services/brain/src/brain/copilot/models.py` - argument and result models, `ToolCall`, `FileCitation`
- CREATE `services/brain/src/brain/copilot/tools.py` - the six functions
- CREATE `services/brain/src/brain/copilot/registry.py` - `ToolSpec` and `COPILOT_TOOLS`
- CREATE `services/brain/src/brain/copilot/store.py` - proposal reads and writes, all scoped by user
- CREATE `services/brain/src/brain/copilot/profile_evidence.py` - AppProfile paths for a node, or nothing
- CREATE `services/brain/tests/test_copilot_tools.py`
- CREATE `services/brain/tests/test_copilot_store.py`
- CREATE `services/brain/tests/test_copilot_registry.py`
- CREATE `services/brain/tests/test_copilot_evidence.py`
- MODIFY `services/brain/pyproject.toml` - add `pydantic-ai-slim` if #95 has not already
- MODIFY `services/brain/README.md` - the tool surface and the rule that #118 imports it rather than copying it

### Acceptance Criteria

- [ ] `propose_patch` writes exactly one row and leaves `experiments.ir` byte-identical, asserted by digesting the row before and after
- [ ] A patch that fails a precondition returns `accepted: false` with the problems and writes no proposal row
- [ ] `apply_patch` on a proposal in status `proposed` returns `awaiting_user_acceptance` and writes nothing
- [ ] `apply_patch` on an accepted proposal whose `based_on_ir_digest` no longer matches the experiment returns `stale` and writes nothing
- [ ] `apply_patch` called twice for the same accepted proposal applies once and then returns `already_applied` with the same `ir_digest_after`
- [ ] The document `apply_patch` writes is byte-identical to the proposal's `patched_ir`, asserted by digesting both
- [ ] Two concurrent `apply_patch` calls against the same experiment leave exactly one `applied` row, enforced by the row lock rather than by application ordering
- [ ] Every tool refuses an experiment belonging to another user with `ExperimentNotFoundError`, indistinguishable from an unknown id
- [ ] No argument model contains an experiment id, a user id or a credential, asserted by a test that walks `COPILOT_TOOLS`
- [ ] `compare_options` with five options is rejected by validation before any pricing is done
- [ ] `compare_options` prices every option against the same `based_on_ir_digest` and records no proposal
- [ ] `price_change` writes no row and returns the same preview as `propose_patch` for identical operations
- [ ] `explain_node` returns an empty `evidence` list for a node with no matching AppProfile entry
- [ ] `explain_node` returns every cost line with the SKU it came from, so a claim about price is traceable
- [ ] Exactly one entry in `COPILOT_TOOLS` has `mutates: true`

### Required Tests

- `test_propose_patch_records_a_proposal_without_touching_the_experiment`
- `test_propose_patch_returns_problems_rather_than_raising_for_a_bad_op_order`
- `test_apply_patch_refuses_a_proposal_the_user_has_not_accepted`
- `test_apply_patch_reports_stale_when_the_document_moved`
- `test_apply_patch_is_idempotent_for_an_already_applied_proposal`
- `test_apply_patch_writes_the_previewed_document_unchanged`
- `test_concurrent_applies_leave_one_applied_proposal`
- `test_every_tool_refuses_another_users_experiment`
- `test_no_argument_model_accepts_an_experiment_or_user_id`
- `test_compare_options_rejects_more_than_four_options`
- `test_compare_options_records_no_proposal`
- `test_price_change_matches_propose_patch_for_the_same_ops`
- `test_explain_node_returns_no_evidence_rather_than_a_plausible_path`
- `test_explain_node_carries_the_sku_for_every_cost_line`
- `test_only_apply_patch_is_declared_as_mutating`

### Performance Budget

`read_architecture` on a 200-node document returns in under 30ms against a warm pool: one query and
one deserialisation, with no per-node round trip. `propose_patch` is bounded by the preview call, whose
budget is set in `030-patch-preview-deltas.md`, plus one insert, and must add under 15ms of its own.
`compare_options` with four options issues four preview calls concurrently rather than serially, so it
stays inside twice the single-preview budget; asserted with `time.perf_counter` in the test.

### Out of Scope

- Do not write a prompt, register a pydantic-ai `Agent`, or make a model call; `040-conversation-run-loop.md` owns the runtime and this issue must be testable with no provider configured
- Do not implement the preview computation; `030-patch-preview-deltas.md` owns `PatchPreview` and the client this issue calls
- Do not reimplement `applyPatch` or `invertPatch` in Python. There is one implementation, in `packages/core/src/ir/patch.ts`, reached through the preview client
- Do not add HTTP routes; the brain's copilot router is `040-conversation-run-loop.md` and the public API is `050-copilot-sse-endpoint.md`
- Do not build the MCP server or add an MCP dependency; #118 imports `COPILOT_TOOLS` and this issue must not anticipate its transport
- Do not add retrieval, embeddings or graph tools. Reading the repository is the profile agent's surface (#97), and a copilot that can grep is a different issue
- Do not persist `ArchitectureDecision` records to make `explain_node` richer. That is a schema change to `analyses` and belongs with the epic that owns it

### Dependencies

Blocked by #27 for the `experiments` table and its `ir` column, #77 and #78 for the IR schema and the
generated Pydantic models, and by `010-ir-patch-protocol.md` for the operation shapes and the digests.
Blocked by `030-patch-preview-deltas.md` for `PatchPreview` and `PreviewClient`: the directory order
puts the tool surface first because it is the boundary a reader needs to see first, while the
dependency runs the other way, and `propose_patch` cannot return a preview it has no type for. #118
consumes `COPILOT_TOOLS` and is not a blocker.

### Verification

```bash
pnpm db:migrate
pnpm db:rollback && pnpm db:migrate
uv run --directory services/brain ruff check .
uv run --directory services/brain ruff format --check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
uv run --directory services/brain pytest -m integration
psql "$DATABASE_URL" -c "\d+ copilot_patch_proposals"
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
