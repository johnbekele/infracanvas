---
title: '[brain] Copilot turn runtime with grounded citations, a tool ceiling and cancellation'
labels: tier:2, size:l, area:brain, epic:13-agent
---

### Epic

#117

### Context

Nothing in this repository has ever held a conversation. The one agent precedent,
`docs/issues/epic-6-brain/040-appprofile-agent-with-citations.md`, is a single-shot run that returns a
structured object and is allowed to take ninety seconds, because a user who asked for an analysis
expects to wait. A copilot turn is the opposite shape: it interleaves tool calls with prose, it has to
start emitting before it knows its own conclusion, and it has to stop the moment the user closes the
panel. This issue is that runtime.

**Grounding is enforced by a ledger, not by asking the model to be careful.** The epic requires that
every factual claim cites a repository file, a price line or a computed prediction. The mechanism that
works for the profile agent -- collect the output, discard findings whose citations no tool returned,
then serialise -- cannot be reused verbatim here, because a token that has been streamed cannot be
withdrawn. So the tool layer records every span, SKU and prediction it returned this turn in a
`GroundingLedger` the model cannot write to, the prompt requires claims to carry an inline marker
(`[file:apps/api/src/lib/db/llm-credentials.ts#L141-L156]`, `[sku:ABC123]`,
`[prediction:<patch digest>]`), and the stream is filtered as it passes: text flows through untouched,
and a marker is checked against the ledger and emitted as a `citation` event that says whether it
stands. A user therefore sees an unsupported citation rendered as unsupported rather than as a link,
and the turn records how many there were. Buffering the whole reply to check it first was rejected
because it removes streaming, which is the feature; buffering only inside a marker is bounded by 220
characters and cannot stall the stream, and a `[` that never closes is flushed as ordinary text so a
code sample cannot deadlock the turn.

**Every limit is a bounded end, not an exception.** A tool ceiling of twelve calls, three proposals per
turn, a 120-second wall clock and a 10-second per-tool timeout. Hitting any of them emits a `limit`
event and finishes the turn with what the model has already said, because a truncated but honest answer
is more use than a stack trace, and because the failure this guards against -- a loop calling
`price_change` forty times on a user's own API key -- is a cost the user pays.

**Preconditions are checked before the first byte.** A missing BYOK credential, an experiment that is
not the caller's, an experiment whose `ir` is still the `'{}'::jsonb` default that
`db/migrations`'s `experiments` table starts with, and an exhausted token budget are all decided before
the stream opens, so each is an HTTP status with a body a client can act on rather than an error event
inside a 200. "No key configured" in particular must read as an instruction: the user has to visit
settings and add a provider, and the message says so, naming the provider list rather than reporting
`MissingCredentialError`.

**The brain emits newline-delimited JSON, not server-sent events.** The framing rules that matter --
event ids for resumption, keepalive comments, the retry field -- belong to the surface the browser
talks to, which is `050-copilot-sse-endpoint.md`. Making the brain speak SSE too would mean two
implementations of those rules and a test suite that parses SSE to assert on Python behaviour. One JSON
object per line is trivial to assert on with `httpx`, and the API translates.

Model calls go through the `MeteredRunner` from `docs/issues/epic-6-brain/060-token-budget-and-cache.md`
with `purpose: 'copilot'`, so the copilot counts against the same monthly budget as everything else and
a cancelled turn still settles the tokens it spent.

Spec: `docs/issues/epic-6-brain/040-appprofile-agent-with-citations.md`

### Contract

```python
# services/brain/src/brain/copilot/events.py
class TokenEvent(BaseModel):
    kind: Literal["token"]
    seq: int
    text: str


class CitationEvent(BaseModel):
    kind: Literal["citation"]
    seq: int
    scheme: Literal["file", "sku", "prediction"]
    target: str
    # False when the ledger has no record of this span, SKU or prediction.
    verified: bool
    reason: str | None


class ToolCallEvent(BaseModel):
    kind: Literal["tool_call"]
    seq: int
    call_id: str
    tool: str
    # What the copilot is doing, in English, built from the arguments by the
    # tool layer. The UI renders this; it never renders arguments.
    summary: str


class ToolResultEvent(BaseModel):
    kind: Literal["tool_result"]
    seq: int
    call_id: str
    tool: str
    ok: bool
    summary: str
    duration_ms: int


class PatchProposedEvent(BaseModel):
    kind: Literal["patch_proposed"]
    seq: int
    proposal_id: UUID
    patch_digest: str
    summary: str
    touched_node_ids: list[str]
    preview: PatchPreview


class LimitEvent(BaseModel):
    kind: Literal["limit"]
    seq: int
    limit: Literal["tool_calls", "proposals", "wall_clock", "tool_timeout"]
    message: str


class ErrorEvent(BaseModel):
    kind: Literal["error"]
    seq: int
    code: Literal["provider_error", "preview_unavailable", "cancelled", "internal"]
    # Safe to show a user. Never a provider response body and never a traceback.
    message: str


class DoneEvent(BaseModel):
    kind: Literal["done"]
    seq: int
    finish: Literal["complete", "limit", "cancelled", "error"]
    input_tokens: int
    output_tokens: int
    tool_calls: int
    unverified_citations: int


CopilotEvent = Annotated[
    TokenEvent | CitationEvent | ToolCallEvent | ToolResultEvent
    | PatchProposedEvent | LimitEvent | ErrorEvent | DoneEvent,
    Field(discriminator="kind"),
]
```

```python
# services/brain/src/brain/copilot/grounding.py
CITATION_PATTERN = re.compile(r"\[(file|sku|prediction):([^\]\s]{1,200})\]")
# A marker longer than this is not a marker. Bounds how much the filter holds.
MAX_MARKER_CHARS = 220


class GroundingLedger:
    """What the tools actually returned this turn. Append-only, written by the
    tool layer, never reachable from a tool argument or a model response."""

    def record_span(self, path: str, start_line: int, end_line: int, sha256: str) -> None: ...
    def record_sku(self, sku: str) -> None: ...
    def record_prediction(self, patch_digest: str) -> None: ...
    def check(self, scheme: str, target: str) -> tuple[bool, str | None]:
        """(verified, reason). A file marker verifies when the path matches and
        the cited range lies inside a range a tool returned; a wider range is
        unverified, because a claim about lines nobody read is a claim."""


class GroundedStream:
    """Passes text through and checks markers as they close.

    Only the characters between an unmatched `[` and its `]` are held, so
    latency is bounded by the marker length rather than by the reply length. A
    run of MAX_MARKER_CHARS with no `]` is flushed as ordinary text.
    """

    async def filter(
        self, tokens: AsyncIterator[str]
    ) -> AsyncIterator[TokenEvent | CitationEvent]: ...
```

```python
# services/brain/src/brain/copilot/run.py
MAX_TOOL_CALLS = 12
MAX_PROPOSALS_PER_TURN = 3
TURN_WALL_CLOCK_SECONDS = 120.0
PER_TOOL_TIMEOUT_SECONDS = 10.0
# Folded into the cache key by MeteredRunner, so a prompt edit invalidates every
# cached turn rather than answering a question no longer being asked.
COPILOT_PROMPT_VERSION = "copilot-v1"
# History is supplied by the API, which owns persistence. Oldest turns are
# dropped first and the drop is stated in the prompt rather than hidden.
MAX_HISTORY_MESSAGES = 20
MAX_HISTORY_CHARS = 24_000


class TurnMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class TurnRequest(BaseModel):
    experiment_id: UUID
    message: str = Field(min_length=1, max_length=8000)
    history: list[TurnMessage] = Field(default_factory=list)


class TurnRefusal(BaseModel):
    """A precondition failure, decided before any streaming begins."""

    code: Literal[
        "experiment_not_found",
        "no_llm_credential",
        "no_architecture",
        "invalid_architecture",
        "budget_exceeded",
    ]
    message: str
    status: int  # 404, 409, 409, 409, 402 respectively


async def check_preconditions(
    request: TurnRequest, user_id: UUID, settings: Settings
) -> TurnRefusal | TurnContext:
    """Load the experiment, validate its IR, resolve the default credential and
    the reasoning scale. Returns a refusal rather than raising, because every
    one of these is a normal state a new user passes through."""


async def run_turn(
    context: TurnContext, request: TurnRequest, cancel: Callable[[], Awaitable[bool]]
) -> AsyncIterator[CopilotEvent]:
    """One turn. Yields events until the model stops, a limit is reached, or
    `cancel()` reports the caller has gone.

    `cancel` is polled between events and before each tool call. On
    cancellation the provider request is aborted, the metering reservation is
    settled in a `finally` with the tokens actually consumed, and a `done`
    event with `finish: 'cancelled'` is the last thing yielded.
    """
```

```
POST /copilot/turns
  X-InfraCanvas-Service-Token: <BRAIN_SERVICE_TOKEN>
  X-InfraCanvas-User-Id: <uuid>          # the API has already authenticated it
  { "experimentId": "...", "message": "...", "history": [...] }

  200 application/x-ndjson    one CopilotEvent per line, `done` last
  402 { "code": "budget_exceeded", ... }
  404 { "code": "experiment_not_found", ... }
  409 { "code": "no_llm_credential", "message": "..." }

POST /copilot/proposals/{proposal_id}/apply
  X-InfraCanvas-Service-Token: <BRAIN_SERVICE_TOKEN>
  X-InfraCanvas-User-Id: <uuid>

  200 { "outcome": "applied" | "already_applied" | ..., "irDigestAfter": "...", ... }
```

The apply route is one call into `apply_patch` from `020-copilot-tool-surface.md` with no model
involved. It lives here because this router is the brain's only HTTP surface, and it exists because
`experiments.ir` has exactly one writer: the accept action in `050-copilot-sse-endpoint.md` reaches it
through this route rather than applying the patch itself.

The tool set registered on the agent is `COPILOT_TOOLS` from `020-copilot-tool-surface.md`, unfiltered.
`apply_patch` is included and is safe to include, because it refuses any proposal the user has not
accepted; the guard lives in the store rather than in which tools happen to be registered, so #118's
callers cannot route around it.

The system prompt lives in `services/brain/src/brain/copilot/prompts/copilot_system_v1.md`, read at
import and versioned by filename. Its load-bearing rules, which the tests assert are present:

- Never write infrastructure code, Terraform, Pulumi, YAML or free text into the architecture. The only
  way to change it is `propose_patch`.
- Every claim about cost carries `[sku:...]` or `[prediction:...]`. Every claim about the repository
  carries `[file:path#Lstart-Lend]`. A claim with no marker must be phrased as a question.
- Never say a change has been made. `propose_patch` proposes; the user accepts.
- When a patch is refused, read the problems and fix the operations. Do not restate the request as
  prose.
- State an unknown as an unknown: a preview with `completeness: 'partial'` is a lower bound and must be
  described as one.

The event fixture that pins this boundary to the API's mirror of it:
`fixtures/copilot/events.example.jsonl`, one line per event kind, written by
`services/brain/tests/test_copilot_events.py` and parsed by the TypeScript suite in
`050-copilot-sse-endpoint.md`.

Every test in this issue runs with no provider configured, using pydantic-ai's `FunctionModel` to play
scripted turns: a turn that calls two tools then answers, a turn that loops, a turn that cites a file it
never read. A copilot that can only be tested against a live model is a copilot nobody will change.

### Files

- CREATE `services/brain/src/brain/copilot/events.py`
- CREATE `services/brain/src/brain/copilot/grounding.py`
- CREATE `services/brain/src/brain/copilot/agent.py` - the pydantic-ai adapter over `COPILOT_TOOLS`
- CREATE `services/brain/src/brain/copilot/run.py` - preconditions, the loop, the limits, cancellation
- CREATE `services/brain/src/brain/copilot/prompts/copilot_system_v1.md`
- CREATE `services/brain/src/brain/routes/copilot.py` - the NDJSON route and the service-token guard
- CREATE `services/brain/tests/test_copilot_events.py` - writes the shared event fixture
- CREATE `services/brain/tests/test_grounding.py`
- CREATE `services/brain/tests/test_copilot_run.py`
- CREATE `services/brain/tests/test_copilot_route.py`
- CREATE `fixtures/copilot/events.example.jsonl` - generated, committed, read by both languages
- MODIFY `services/brain/src/brain/app.py` - mount the copilot router
- MODIFY `services/brain/README.md` - how to drive a turn locally against Ollama with no key

### Acceptance Criteria

- [ ] A turn with no default `llm_credentials` row returns 409 with a message naming the settings page, before any provider call and before the stream opens
- [ ] A turn against an experiment whose `ir` is the default empty object returns 409 `no_architecture` rather than proposing against nothing
- [ ] A turn against another user's experiment returns 404, indistinguishable from an unknown id
- [ ] A turn that would exceed the monthly token budget returns 402 and makes no provider call
- [ ] The reasoning scale sent to the provider is the one in `user_settings.reasoning_scale`, asserted for all three values
- [ ] A citation naming a file span no tool returned is emitted with `verified: false` and a reason, and the turn still completes
- [ ] A citation whose range is wider than the span a tool returned is unverified, not verified
- [ ] Text outside a marker is emitted without waiting for the marker that follows it, asserted by event ordering
- [ ] An unclosed `[` is flushed as text after `MAX_MARKER_CHARS` rather than holding the stream open
- [ ] The thirteenth tool call is refused with a `limit` event and the turn finishes with `finish: 'limit'`
- [ ] A fourth `propose_patch` in one turn is refused with a `limit` event and writes no proposal row
- [ ] A tool that exceeds `PER_TOOL_TIMEOUT_SECONDS` yields a `tool_result` with `ok: false` and the turn continues
- [ ] Cancellation stops the provider request, settles the metering reservation with the tokens consumed, and ends with `finish: 'cancelled'`
- [ ] A provider failure mid-turn yields an `error` event whose message contains no provider response body and no API key
- [ ] History longer than `MAX_HISTORY_MESSAGES` drops the oldest turns and says so in the prompt
- [ ] Every event kind appears in `fixtures/copilot/events.example.jsonl`, asserted against the union rather than a hand-written list
- [ ] The route rejects a request without the service token, and the token appears in no log line
- [ ] `POST /copilot/proposals/:id/apply` makes no model call and returns the outcome `apply_patch` reports, including `awaiting_user_acceptance`

### Required Tests

- `test_refuses_a_turn_with_no_configured_credential_before_streaming`
- `test_refuses_a_turn_against_an_experiment_with_no_architecture`
- `test_returns_not_found_for_another_users_experiment`
- `test_refuses_a_turn_that_would_exceed_the_token_budget`
- `test_sends_the_configured_reasoning_scale`
- `test_marks_a_citation_the_ledger_does_not_support_as_unverified`
- `test_marks_an_over_wide_citation_range_as_unverified`
- `test_streams_text_before_the_following_marker_closes`
- `test_flushes_an_unclosed_marker_as_text`
- `test_stops_after_the_tool_call_ceiling`
- `test_refuses_a_fourth_proposal_in_one_turn`
- `test_a_slow_tool_times_out_without_ending_the_turn`
- `test_cancellation_settles_the_reservation_and_reports_cancelled`
- `test_provider_error_message_contains_no_key_or_response_body`
- `test_drops_the_oldest_history_and_says_so`
- `test_every_event_kind_is_in_the_committed_fixture`
- `test_route_rejects_a_missing_service_token`
- `test_apply_route_makes_no_model_call`

### Performance Budget

The runtime's own overhead is under 5ms per 100 tokens, and the grounding filter adds under 2% to the
wall clock of a turn, both measured with `time.perf_counter` against a `FunctionModel` that emits a
fixed 4000-token reply so the figure is not a measurement of somebody's API. A token leaves the route
within 20ms of arriving from the provider, so the perceived latency is the provider's rather than ours.
The 120-second wall clock and the twelve-call ceiling are the hard bounds on a turn.

### Out of Scope

- Do not define or implement any tool. `020-copilot-tool-surface.md` owns all six, and this runtime must
  work by registering whatever `COPILOT_TOOLS` contains
- Do not compute a preview. The tools already carry one, from `030-patch-preview-deltas.md`
- Do not persist conversations, messages or events. The brain is stateless per turn apart from proposal
  rows; `050-copilot-sse-endpoint.md` owns persistence and passes history in
- Do not speak server-sent events, and do not emit an event id or a keepalive. Those belong to the
  browser-facing surface
- Do not add a second credential path, a provider client, or a reasoning table. #95 builds the model and
  #96 maps the scale; a `MissingCredentialError` from #95 is translated here and nothing more
- Do not implement retrieval over the repository. Repository grounding comes from what the tools return,
  and a copilot that can search code is a separate issue with its own token budget
- Do not add a queue or a background worker. A turn lives inside the request that asked for it, which is
  why cancellation is possible at all

### Dependencies

Blocked by #95 for `build_model` and `load_default_credential`, #96 for the reasoning mapping, #99 for
`MeteredRunner` and the budget refusal, #27 for the `experiments` table, and by
`020-copilot-tool-surface.md` and `030-patch-preview-deltas.md` for the tools and the preview client.

### Verification

```bash
uv run --directory services/brain ruff check .
uv run --directory services/brain ruff format --check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
pnpm db:migrate && uv run --directory services/brain pytest -m integration
git diff --exit-code fixtures/copilot/events.example.jsonl
# A turn against a local Ollama with no key, streaming NDJSON.
curl -N -X POST localhost:8000/copilot/turns \
  -H "X-InfraCanvas-Service-Token: $BRAIN_SERVICE_TOKEN" \
  -H "X-InfraCanvas-User-Id: $USER_ID" \
  -H 'content-type: application/json' \
  --data '{"experimentId":"'"$EXPERIMENT_ID"'","message":"why is the database a single point of failure"}'
```

### Risk Tier

tier:2 - normal application code. It runs on a decrypted user credential, as the profile agent in #97
already does, but adds no credential handling of its own and no path in Gate 7's tier-1 expression

### Size

size:l - over 600 lines
