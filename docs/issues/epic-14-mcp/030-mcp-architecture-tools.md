---
title: '[brain] Architecture read and edit tools served from the copilot registry, not reimplemented'
labels: tier:2, size:m, area:brain, epic:14-mcp
---

### Epic

#118

### Context

`docs/issues/epic-13-agent/020-copilot-tool-surface.md` already decided this issue's central question
and said so: its tools are plain async functions rather than pydantic-ai closures specifically because
"the copilot has two callers from the start", and it publishes
`COPILOT_TOOLS: tuple[ToolSpec, ...]` described as "the one list. 040 registers from it, #118 serves
from it, and a tool that is in neither place is in neither list." So this issue serves from that tuple.
It does not import the six functions by name, and it does not keep its own table of names to callables,
because either of those is a second enumeration of the tool surface that a seventh tool could be
missing from.

That distinction is worth being precise about, because a name-to-callable table looks like the safe
option and is not. If this issue lists six names, then epic 13 adding a `suggest_reservation` tool
leaves the MCP surface silently short, and nothing fails: the golden file diff shows no change, every
parity assertion still passes, and the omission is discovered by a user whose agent cannot do the thing
the chat panel can. Iterating `COPILOT_TOOLS` inverts that. A new tool appears in `tools/list`
automatically, the golden file changes, and a reviewer has to look at it.

The parity test therefore asserts identity of the registered handler against
`{spec.name: spec.handler for spec in COPILOT_TOOLS}`, with `is`, plus set equality of names. A test
comparing behaviour was considered and rejected: it would pass a reimplementation that happened to
agree on the cases somebody thought to write, which is exactly the failure -- two implementations that
agree until they do not -- that #117 and #118 are both organised to prevent.

**The adapter's only freedoms are scope and shape.** Epic 13's handlers take
`(deps: CopilotDeps, args: BaseModel)`, and `CopilotDeps` carries `experiment_id`, `user_id`, `pool`
and the `PreviewClient` from `docs/issues/epic-13-agent/030-patch-preview-deltas.md`. Epic 13 states
the rule this issue inherits: "Every tool takes its scope from `CopilotDeps`, never from its arguments:
there is no `experiment_id` or `user_id` in any argument model." A chat turn knows its experiment
because a conversation is about one. MCP has no conversation, so the experiment has to be named per
call -- and it is named as an adapter parameter that becomes `CopilotDeps.experiment_id`, never as a
field of an epic 13 argument model. The `user_id` comes from the `Principal` and cannot be named by a
caller at all.

So the adapter may add a parameter that it consumes itself, and may project a return value for a
context window. It may not alter, default or coerce anything on its way into `args`. An argument that
needs adjusting is a signature defect, and it is fixed in the epic 13 issue that owns the signature.

**An IR document does not fit in a model's context, and clipping JSON is worse than not returning
it.** `read_architecture` returns epic 13's `ArchitectureView`, which is deliberately the whole `ir`
plus an index of it, sized for a chat backend that streams a diff card rather than for a tool result a
model pays for by the token. `packages/ir-schema` budgets validation for a 500-node document, and a
hundred-node architecture with typed parameters is comfortably a hundred kilobytes of JSON. Truncating
that to fit produces invalid JSON, the one failure a model cannot recover from, because the parse error
says nothing about what was dropped.

The projection is therefore three views over the same `ArchitectureView`: a summary that drops `ir` and
the node lists, a node index that keeps `nodes` and `edges` and drops `ir`, and the full document only
when it fits under a byte cap. When it does not fit, the result carries a `resource_link` to an MCP
resource instead of a clipped document, and the client fetches it out of band into wherever it keeps
large context, which is what resources are for. Note that this needs no change to epic 13: every view
is a projection of a value that function already returns.

Paginating the document across tool calls was the alternative. A page of a JSON document is not a JSON
document, so the model would have to concatenate before it could parse, every boundary is a chance to
lose a byte, and the failure is silent. A resource URI is one round trip and the client's own problem.

**`apply_patch` over MCP cannot bypass the human, and this issue must not add a way to.** Epic 13's
`apply_patch` takes a `proposal_id`, refuses any proposal not in status `accepted`, and returns
`awaiting_user_acceptance`. That guard is in the store rather than in a tool list precisely so that
"#118's callers would need a second, unguarded path to apply anything". An agent driving this server
can propose, price and compare freely, and lands an edit only after a person accepted it in the web
application. That is the intended shape, so the outcome is reported to the model as a normal result
with a message telling it what it is waiting for, rather than as an error it should retry.

**The input schemas are generated, and the generated output is committed.** The SDK derives each
tool's `inputSchema` from the adapter signature and epic 13's `args_model`, which is what makes
importing the registry a single contract: the schema a client validates against is a projection of the
models a maintainer edits. Hand-written schemas would reintroduce the second statement of the contract.
To keep the projection reviewable, the whole `tools/list` response is snapshotted into
`services/brain/tests/fixtures/mcp/tools-list.json`, following the golden-output approach in
`docs/issues/epic-8-codegen/040-deterministic-golden-output.md`, so an epic 13 signature change arrives
here as a diff somebody approves rather than as a silent change in what agents are told.

Spec: https://modelcontextprotocol.io/specification/2026-07-28/server/tools, docs/issues/epic-2-ir/010-architecture-ir-schema.md

### Contract

Registration iterates the registry. There is no local list of tool names:

```python
# services/brain/src/brain/mcp/tools/architecture.py
from brain.copilot.registry import COPILOT_TOOLS, ToolSpec

#: Extra parameters the adapter accepts and consumes itself, by tool name. These
#: never reach an epic 13 argument model. Only read_architecture has any.
ADAPTER_PARAMS: Mapping[str, type[BaseModel]] = {"read_architecture": ReadViewParams}


def register_copilot_tools(mcp: MCPServer, allowed: frozenset[str]) -> list[BoundTool]:
    """Register one MCP tool per ToolSpec whose scope the process token carries.

    Returns what it registered so test_mcp_architecture_parity.py can assert
    handler identity without reaching into the server's internals.
    """


@dataclass(frozen=True, slots=True)
class BoundTool:
    name: str
    #: The identical object COPILOT_TOOLS carries. Asserted with `is`.
    handler: Callable[[CopilotDeps, BaseModel], Awaitable[BaseModel]]
    spec: ToolSpec
```

Every tool is registered through one adapter factory, so there are no per-tool code paths to drift:

```python
def _adapt(spec: ToolSpec) -> Callable[..., Awaitable[object]]:
    """Build the MCP tool for one ToolSpec.

    read_only_hint is `not spec.mutates`, so the registry's own declaration
    drives the annotation and a future mutating tool cannot be advertised to
    clients as safe by omission.
    """

    async def tool(
        experiment_id: UUID,
        args: spec.args_model,  # type: ignore[valid-type]  # nested under $defs
        ctx: Context[BrainMcpContext],
        principal: Annotated[Principal, Resolve(resolve_principal)],
    ) -> object:
        principal.require(TOOL_SCOPES[spec.name])
        deps = CopilotDeps(
            experiment_id=experiment_id,
            user_id=principal.user_id,
            pool=ctx.request_context.lifespan_context.pool,
            preview=ctx.request_context.lifespan_context.preview,
        )
        try:
            return await spec.handler(deps, args)
        except ExperimentNotFoundError as exc:
            raise ToolFailure("not_found", "No such experiment.") from exc

    return tool
```

`ctx` and `principal` are invisible to the model: the SDK omits a `Context` parameter and a `Resolve`d
parameter from the input schema and ignores any value a client sends for them. So no tool in this epic
carries a user id, a token or a database handle in its schema, and `experiment_id` is the only
identifier a caller supplies.

`ExperimentNotFoundError` is epic 13's single answer for "no experiment with this id belongs to this
user", documented there as deliberately not distinguishing a wrong owner "because a distinct error
would confirm the id exists". It maps to one `not_found` failure here for the same reason, and
`020-mcp-authentication-and-scoping.md` covers the same ground for every other table.

The three views, which exist entirely in this layer:

```python
# services/brain/src/brain/mcp/views.py
class IrView(StrEnum):
    SUMMARY = "summary"  # counts, kinds, cost. Bounded regardless of document size.
    NODES = "nodes"      # ArchitectureView.nodes and .edges. No params, no ir.
    FULL = "full"        # the ir itself, subject to max_bytes.


class ReadViewParams(BaseModel):
    view: IrView = IrView.SUMMARY
    #: Restrict nodes and edges to this subgraph. Empty means everything.
    node_ids: list[str] = Field(default_factory=list, max_length=200)
    max_bytes: int = Field(default=32_768, ge=1024, le=262_144)


class ArchitectureRead(BaseModel):
    experiment_id: UUID
    view: IrView
    #: ArchitectureView.ir_digest, which epic 13's 010-ir-patch-protocol.md defines
    #: over the semantics with layout and presentation removed. Dragging a node on
    #: the canvas therefore does not change it, which is why
    #: 050-mcp-destructive-tool-guardrail.md can bind a confirmation to it.
    ir_digest: str
    region: str
    node_count: int
    edge_count: int
    nodes_by_kind: dict[str, int]
    monthly_usd: float | None
    #: Populated for NODES and FULL. Empty for SUMMARY.
    nodes: list[NodeSummary]
    edges: list[EdgeSummary]
    #: Present only for FULL, and only when the document fits in max_bytes.
    ir: dict[str, object] | None
    omitted_node_count: int
    #: True when the requested view did not fit. The document is then absent
    #: rather than clipped, and ir_resource_uri is how to read it.
    truncated: bool
    byte_size: int
    ir_resource_uri: str  # infracanvas://experiment/<id>/ir
```

The generated input schema for `read_architecture`, which is what a client sees and what the golden
file pins. `args` is epic 13's `ReadArchitectureArgs` and appears by reference:

```json
{
  "type": "object",
  "properties": {
    "experiment_id": { "type": "string", "format": "uuid", "title": "Experiment Id" },
    "args": { "$ref": "#/$defs/ReadArchitectureArgs" },
    "view": {
      "$ref": "#/$defs/IrView",
      "default": "summary",
      "description": "summary for counts and cost, nodes for the index, full for the document."
    },
    "node_ids": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 200,
      "default": [],
      "description": "Restrict nodes and edges to this subgraph."
    },
    "max_bytes": { "type": "integer", "minimum": 1024, "maximum": 262144, "default": 32768 }
  },
  "required": ["experiment_id", "args"],
  "$defs": {
    "IrView": { "enum": ["summary", "nodes", "full"] },
    "ReadArchitectureArgs": { "description": "Generated from brain.copilot.tools" }
  }
}
```

Every `$defs` body sourced from epic 13 is elided in this document on purpose. Writing one out would be
a second statement of epic 13's contract, which is the thing this issue exists to prevent; the
authoritative copy is the committed `tools-list.json`. The same applies to `ProposePatchArgs`,
`ApplyPatchArgs`, `CompareOptionsArgs` and `PriceChangeArgs`, whose ceilings -- `MAX_OPS_PER_PATCH` of
50 and `MAX_COMPARE_OPTIONS` of 4 -- reach clients as `maxItems` through the generated schema rather
than as a check written here.

Each `outputSchema` is generated from the return annotation, so `propose_patch` advertises
`PatchProposal` with its `problems` list and a model can see that a refusal is a value rather than a
crash. `read_architecture` is the one tool whose output schema is this issue's own model rather than
epic 13's, because `ArchitectureRead` is the projection.

The resource carrying the full document, scoped exactly like the tools:

```python
# services/brain/src/brain/mcp/resources.py
@mcp.resource("infracanvas://experiment/{experiment_id}/ir", mime_type="application/json")
async def experiment_ir(experiment_id: str, ctx: Context) -> str:
    """The complete Architecture IR for one experiment.

    Scoped by the same `id = %s AND user_id = %s` predicate as every tool,
    because a resource URI is a name and not a capability: the protocol has no
    session, so authorization is checked on each read rather than at the moment
    the link was handed out.
    """
```

`resources` is declared as a server capability alongside `tools`. A `full` read that does not fit
returns a `resource_link` content block rather than a clipped document:

```json
{
  "type": "resource_link",
  "uri": "infracanvas://experiment/8f1c.../ir",
  "name": "architecture-ir.json",
  "description": "Full Architecture IR, 184320 bytes. Requested view exceeded max_bytes.",
  "mimeType": "application/json"
}
```

### Files

- CREATE `services/brain/src/brain/mcp/tools/__init__.py`
- CREATE `services/brain/src/brain/mcp/tools/architecture.py` - the adapter factory and `BoundTool`
- CREATE `services/brain/src/brain/mcp/views.py` - `IrView`, `ReadViewParams`, `ArchitectureRead`, the
  projections and the byte accounting
- CREATE `services/brain/src/brain/mcp/resources.py`
- CREATE `services/brain/tests/test_mcp_architecture_parity.py`
- CREATE `services/brain/tests/test_mcp_architecture_tools.py`
- CREATE `services/brain/tests/test_mcp_views.py`
- CREATE `services/brain/tests/test_mcp_tools_list_golden.py`
- CREATE `services/brain/tests/fixtures/mcp/tools-list.json` - generated, committed
- CREATE `services/brain/tests/fixtures/mcp/ir-500-nodes.json` - a document over the byte cap
- MODIFY `services/brain/src/brain/mcp/server.py` - call `register_copilot_tools`, register the
  resource, declare the `resources` capability, put the `PreviewClient` in the lifespan context
- MODIFY `services/brain/README.md` - the served tools, the three views, and the resource URI

### Acceptance Criteria

- [ ] The set of registered tool names equals `{spec.name for spec in COPILOT_TOOLS}` filtered by the token's scopes, with no name written literally in this package
- [ ] For every registered tool, `BoundTool.handler is spec.handler` for the matching entry in `COPILOT_TOOLS`, asserted with `is` rather than by comparing behaviour
- [ ] Adding a seventh `ToolSpec` to `COPILOT_TOOLS` in a test double makes it appear in `tools/list` with no change to this package
- [ ] `read_only_hint` is `not spec.mutates` for every tool, so `apply_patch` is the only one advertised as mutating
- [ ] No epic 13 argument model contains `experiment_id` or `user_id`, re-asserted here so a change there fails this issue's suite too
- [ ] Neither `ctx` nor `principal` appears in any generated `inputSchema`
- [ ] A client that sends a `principal` argument has it ignored, and the call still resolves the principal from the process token
- [ ] The adapter passes the client's `args` object to `spec.handler` unmodified, asserted by comparing the model dump at the boundary
- [ ] `tools/list` matches the committed `tools-list.json` byte for byte, and regenerating twice leaves the working tree clean
- [ ] `read_architecture` with no `view` returns `summary` under 4 KB for the 500-node fixture, with `ir` absent
- [ ] `read_architecture` with `view: "full"` over `max_bytes` returns `truncated: true`, `ir: null`, and a `resource_link`
- [ ] A truncated result never contains a partial JSON document
- [ ] `max_bytes` above 262144 is rejected by the generated schema before the tool body runs
- [ ] `node_ids` returns those nodes plus the edges touching them and reports `omitted_node_count`
- [ ] `ir_digest` is unchanged by a layout-only edit and changes after `apply_patch` lands
- [ ] `apply_patch` on a proposal no user has accepted returns `awaiting_user_acceptance` as a normal result, not an error, and leaves `experiments.ir` unchanged
- [ ] Every tool and the IR resource refuse another user's experiment as `not_found`, indistinguishable from an unknown id

### Required Tests

- `test_served_names_are_exactly_the_registry_names`
- `test_every_registered_handler_is_the_registry_callable`
- `test_a_new_registry_entry_appears_without_editing_this_package`
- `test_read_only_hint_follows_the_registry_mutates_flag`
- `test_no_copilot_argument_model_accepts_an_experiment_or_user_id`
- `test_principal_and_context_are_absent_from_every_input_schema`
- `test_a_client_supplied_principal_is_ignored`
- `test_adapter_passes_arguments_through_unmodified`
- `test_tools_list_matches_the_golden_file`
- `test_default_view_is_a_bounded_summary`
- `test_full_view_over_the_cap_returns_a_resource_link_not_clipped_json`
- `test_max_bytes_above_the_hard_cap_is_rejected_by_the_schema`
- `test_node_ids_returns_the_subgraph_and_reports_what_it_omitted`
- `test_ir_digest_ignores_layout_and_changes_on_apply`
- `test_apply_patch_reports_awaiting_user_acceptance_as_a_result`
- `test_tools_and_resource_refuse_another_users_experiment`

### Performance Budget

The adapter adds under 5 ms to any call: one scope check, one `CopilotDeps` construction and one
`model_validate`, with no query of its own, since epic 13 budgets `read_architecture` at under 30 ms
for a 200-node document and owns every read. The `summary` view completes in under 60 ms end to end for
the 500-node fixture and returns under 4 KB, so an agent can orient itself for the price of one small
tool result. Byte size is measured on the serialised result before the truncation decision rather than
estimated from the node count, because a node's parameter bag has no bounded width. A `full` read is
capped at 262144 bytes, which bounds both the response and the memory held per call.

### Out of Scope

- Do not implement, wrap or patch any of epic 13's six functions. If `COPILOT_TOOLS` does not exist
  yet, this issue is blocked on #117 and must not be unblocked by writing a handler here
- Do not keep a list of tool names in this package. The registry is the list, and a local copy is the
  drift this issue exists to prevent
- Do not normalise, default or coerce a value on its way into an epic 13 argument model. That is a
  signature defect and belongs in the issue that owns the signature
- Do not add a tool that accepts a proposal on the user's behalf, and do not relax
  `awaiting_user_acceptance`. A person accepting an edit is the boundary #117 put in the store
- Do not add the lifecycle tools; `040-mcp-lifecycle-tools.md` owns analyse, deploy, load test and
  destroy
- Do not add a confirmation requirement to `apply_patch`. It writes a database row, spends no money and
  destroys nothing, and a confirmation on every edit trains an operator to click through the ones that
  matter
- Do not paginate the IR across tool calls. A page of a JSON document is not parseable
- Do not modify `packages/ir-schema` or the generated Pydantic models. This issue reads the IR and never
  redefines it
- Do not add MCP prompts. A prompt is a template for a user, and these tools are for a model

### Dependencies

Blocked by `010-mcp-server-skeleton.md` and `020-mcp-authentication-and-scoping.md`. Blocked by #117,
specifically `docs/issues/epic-13-agent/020-copilot-tool-surface.md` for `COPILOT_TOOLS`, `ToolSpec`,
`CopilotDeps`, `ArchitectureView` and `ExperimentNotFoundError`,
`docs/issues/epic-13-agent/010-ir-patch-protocol.md` for `IrPatchOp` and `irDigest`, and
`docs/issues/epic-13-agent/030-patch-preview-deltas.md` for the `PreviewClient` the adapter puts in
`CopilotDeps`. Also depends on #78 for the generated Pydantic IR models and #27 for `experiments.ir`.
If a signature in epic 13 changes, the fix is to regenerate the golden file, never to adapt an
argument here.

### Verification

```bash
uv run --directory services/brain ruff check .
uv run --directory services/brain ruff format --check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
pnpm db:migrate && uv run --directory services/brain pytest -m integration
uv run --directory services/brain python -m brain.mcp.dump_tools \
  > services/brain/tests/fixtures/mcp/tools-list.json \
  && git diff --exit-code services/brain/tests/fixtures/mcp/tools-list.json
```

The last command is how the golden file is regenerated and how the gate proves it was not forgotten: a
signature change in epic 13 makes `tools/list` differ, the regeneration writes it, and a clean
`git diff` is the assertion that the committed schema is the one the code produces.

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
