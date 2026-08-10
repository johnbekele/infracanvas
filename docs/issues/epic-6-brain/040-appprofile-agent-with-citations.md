---
title: '[brain] AppProfile agent with per-field confidence and citations'
labels: tier:2, size:l, area:brain, epic:6-brain
---

### Epic

#7

### Context

`packages/core/src/analysis/profile.ts` already produces an `AppProfile`, deterministically, from
dependency manifests, Dockerfiles and GitHub's language breakdown. That pass is correct about
everything it has a rule for and silent about everything else. A service that reaches Postgres
through a hand-rolled connection helper, a worker with no job framework in its manifest, a queue used
through raw SDK calls: none of these appear in a manifest, and none of them appear in the profile
today, so the architecture proposed from it is missing a database, a worker, and a queue.

This issue adds a second pass that reads code and fills those gaps. The risk is obvious and stated
plainly in the header of `profile.ts`: a hallucinated dependency becomes a provisioned database. The
defence is that the agent may only make claims it can point at. Every finding it adds carries a
`path`, a line range, and the SHA-256 of the file it was read from, and a finding whose citation does
not correspond to a span the tools actually returned is discarded before the model's output is ever
merged. That check is mechanical -- it compares the citation against a list the tool layer recorded,
not against the model's own account of what it read -- so it holds regardless of how convincing the
output looks.

**The agent adds, it does not overrule.** Where the deterministic pass has an opinion, it wins.
`pg` in a manifest means Postgres whatever the model thinks, and an ORM still leaves `capability`
unset, because that rule exists precisely to stop an engine being guessed. The alternative -- letting
the agent produce the whole profile -- was rejected: it would make a result that is currently exact
and reproducible depend on a sampling temperature, and it would throw away rules that are already
tested.

**The shape stays identical to the TypeScript interface.** The Python model carries the citation
envelope, and `to_app_profile()` strips it to produce exactly the object `profile.ts` describes,
camel-cased and schema-versioned. Two divergent notions of what a profile is would eventually need a
translation layer in the middle of the product's central data structure, so the serialised round trip
is asserted by test rather than by intention.

Tool reads come from the `files` and `chunks` tables rather than from a working copy, so the agent
sees exactly the snapshot the ingestion run captured and no checkout is needed on the machine.

Spec: `packages/core/src/analysis/profile.ts`

### Contract

```python
# services/brain/src/brain/profile/models.py
PROFILE_SCHEMA_VERSION = 1

# Anything below this is reported as a note instead of a finding. A profile is
# an input to provisioning, so a coin toss does not belong in it.
MIN_CONFIDENCE = 0.5


class Citation(BaseModel):
    path: str
    start_line: int  # 1-based, inclusive
    end_line: int  # inclusive
    # Of the whole file as read. Lets a later check tell "the claim was wrong"
    # apart from "the file moved underneath the claim".
    file_sha256: str


class Cited[T](BaseModel):
    value: T
    # The agent's stated probability that the claim holds. Deterministic
    # findings are 1.0 and the agent is capped at 0.9, so the two are always
    # distinguishable in the output.
    confidence: float = Field(ge=0.0, le=1.0)
    citations: list[Citation] = Field(min_length=1)
    source: Literal["deterministic", "agent"]


class CitedAppProfile(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    schema_version: Literal[1]
    commit_sha: str
    ref: str
    analysed_at: datetime
    languages: list[LanguageBreakdown]
    components: list[Cited[Component]]
    dependencies: list[Cited[DetectedDependency]]
    containerisation: Cited[Containerisation]
    file_count: int
    total_bytes: int
    notes: list[str]

    def to_app_profile(self) -> dict[str, object]:
        """Strip the envelope. The result validates against the TypeScript
        `AppProfile` in packages/core/src/analysis/profile.ts."""
```

`Component`, `DetectedDependency`, `Containerisation`, `LanguageBreakdown`, `Ecosystem`,
`Capability` and `DependencyCategory` are Pydantic and `Literal` restatements of the TypeScript
types, field for field, with no additions.

```python
# services/brain/src/brain/profile/tools.py
MAX_SPAN_LINES = 200
MAX_READS = 60


@dataclass
class ProfileDeps:
    repository_id: UUID
    run_id: UUID
    pool: AsyncConnectionPool
    # Every span a tool actually returned, appended by the tool layer. The
    # agent cannot write to this, which is the whole point.
    reads: list[Citation] = field(default_factory=list)


async def list_files(ctx: RunContext[ProfileDeps], path_glob: str) -> list[FileEntry]: ...
async def read_span(
    ctx: RunContext[ProfileDeps], path: str, start_line: int, end_line: int
) -> SpanText: ...
async def search_text(
    ctx: RunContext[ProfileDeps], pattern: str, limit: int = 20
) -> list[Citation]: ...
```

```python
# services/brain/src/brain/profile/agent.py
profile_agent: Agent[ProfileDeps, AgentFindings]


async def build_profile(
    deterministic: AppProfileInput,
    deps: ProfileDeps,
    model: Model,
    reasoning: ReasoningSettings,
) -> CitedAppProfile:
    """Run the agent, discard unsupported findings, and merge what survives
    into the deterministic profile. Deterministic findings win on conflict.

    One repair round: rejected findings are returned to the agent with the
    reason, and the run ends after the second attempt regardless.
    """
```

```
POST /profile  {repositoryId, runId}  -> 200 {profile: CitedAppProfile}
                                         404 when the run is not this user's
                                         422 when the agent produced nothing usable
```

### Files

- CREATE `services/brain/src/brain/profile/__init__.py`
- CREATE `services/brain/src/brain/profile/models.py`
- CREATE `services/brain/src/brain/profile/tools.py`
- CREATE `services/brain/src/brain/profile/agent.py`
- CREATE `services/brain/src/brain/profile/merge.py`
- CREATE `services/brain/src/brain/routes/profile.py`
- MODIFY `services/brain/src/brain/app.py` - mount the profile router
- CREATE `services/brain/tests/test_profile_models.py`
- CREATE `services/brain/tests/test_profile_merge.py`
- CREATE `services/brain/tests/test_profile_tools.py`
- CREATE `services/brain/tests/test_profile_agent.py`
- CREATE `services/brain/tests/fixtures/profile/expected_profile.json`

### Acceptance Criteria

- [ ] A finding whose citation was never returned by a tool is discarded, and the discard is recorded in `notes`
- [ ] A finding with confidence below 0.5 is recorded in `notes` rather than added to the profile
- [ ] An agent finding may not exceed confidence 0.9; a higher value is clamped and noted
- [ ] A deterministic finding and an agent finding for the same dependency resolve to the deterministic one
- [ ] The agent cannot set `capability` on a dependency the deterministic pass classified as an ORM
- [ ] `to_app_profile()` output validates against the TypeScript `AppProfile` and carries `schemaVersion: 1`
- [ ] `read_span` refuses a range wider than 200 lines rather than truncating it silently
- [ ] `read_span` for a path outside the run returns an error to the agent instead of reading it
- [ ] After 60 reads the tools refuse further calls and the run finishes with what it has
- [ ] The run makes at most two model calls, the second only to repair rejected findings
- [ ] Every citation records the file SHA-256 as read, not as stored at request time
- [ ] `POST /profile` returns 404, not 403, for a run belonging to another user

### Required Tests

- `test_discards_a_finding_citing_a_span_no_tool_returned`
- `test_records_a_low_confidence_finding_as_a_note`
- `test_clamps_agent_confidence_to_the_ceiling`
- `test_deterministic_finding_wins_over_a_conflicting_agent_finding`
- `test_agent_cannot_attach_a_capability_to_an_orm`
- `test_serialises_to_the_typescript_app_profile_shape`
- `test_read_span_rejects_an_over_wide_range`
- `test_read_span_refuses_a_path_outside_the_run`
- `test_stops_after_the_read_budget_is_exhausted`
- `test_repairs_once_then_gives_up`

### Performance Budget

Profiling the 120-file fixture repository completes in under 90 seconds and under 60k input tokens
against `llama3.1:8b` on a local Ollama, both recorded by the integration test and asserted. The
serialised profile stays under 256KB, which keeps it inside a single `jsonb` read.

### Out of Scope

- Do not verify that a cited span supports its claim; `050-citation-verifier.md` owns that
- Do not touch `packages/core/src/analysis/profile.ts` or `architecture.ts`
- Do not add embedding or vector retrieval; `search_text` uses the existing full-text column on `chunks`
- Do not check out the repository to disk; the tools read `files` and `chunks` only
- Do not count tokens against a budget or cache responses; `060-token-budget-and-cache.md` owns both

### Dependencies

Blocked by #24 and #25, and by the registry in
`docs/issues/epic-6-brain/020-provider-registry.md` and the mapping in
`docs/issues/epic-6-brain/030-reasoning-scale-mapping.md`.

### Verification

```bash
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
pnpm db:migrate && uv run --directory services/brain pytest -m integration
pnpm --filter @infracanvas/core test
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
