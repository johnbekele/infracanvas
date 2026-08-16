---
title: '[brain] Lifecycle tools that hand back a pollable operation handle instead of blocking'
labels: tier:1, size:l, area:brain, epic:14-mcp
---

### Epic

#118

### Context

Analysing a repository, deploying, load testing and destroying are the four operations that make this
server more than a drawing tool, and none of them can be answered inside a tool call. A CodeBuild deploy
in `docs/issues/epic-9-deploy/030-codebuild-deploy-with-log-stream.md` runs for minutes; a load test in
`docs/issues/epic-10-loadtest/020-fargate-spot-runner.md` is twelve 60-second ramp stages, so twelve
minutes before it can say anything final. A tool call that waits for either one is a request held open
past every default client timeout, and when the client gives up the work carries on with nobody
watching. So each of these tools starts the operation, returns a handle, and the model polls.

**These tools do not do the work, and they must not learn how.** Deploy assumes a role in the user's
AWS account (`docs/issues/epic-9-deploy/010-cross-account-role-connect.md`), the load test runner calls
ECS `RunTask` and reads stopped reasons back, and destroy sweeps real resources. Every one of those
paths already exists once, in TypeScript in `apps/api`, next to the credential handling and the
guardrails. Reimplementing any of it in Python would be the exact drift this epic is organised against,
and it would put cross-account credentials in a second process. So the lifecycle tools are clients of
the same HTTP routes the browser calls: `POST /experiments/:id/deploy`, `POST /experiments/:id/destroy`,
`POST /repositories/:id/analyses`, and the load test routes #70 defines in
`apps/api/src/routes/experiments/loadtest.ts`. The single implementation is the route and its handler.
This server adds a tool schema, a scope check and a confirmation check, and forwards.

**The brain holds no ambient authority.** The obvious way to let one service call another is a shared
service credential plus a header naming the user to act as. It was rejected: it creates a component that
can act as anybody, so a defect anywhere in the brain becomes a defect that reaches every user's AWS
account. Instead the caller's own personal access token is forwarded as
`Authorization: Bearer ic_pat_...`, and `apps/api` authenticates it against `mcp_tokens` with the same
scope rules, as specced in `020-mcp-authentication-and-scoping.md`. The brain then has exactly the
authority of the token currently in its hands and none in between calls. The cost is that token
verification exists in both languages; 020 pins that with shared hash vectors, and verification is one
digest and one indexed lookup rather than a policy engine.

**One handle shape over four different substrates.** This is the part worth reading carefully, because
the four operations are not stored alike and the natural implementation leaks that at the model. Deploy
and destroy are rows in the `jobs` table from `docs/issues/epic-1-data/070-durable-job-queue.md` with
progress in `job_events`. A load test is a `loadtest_runs` row with an ECS task ARN, whose status is
reconciled by `pollLoadTest` calling ECS. A repository analysis is an `analyses` row that
`POST /repositories/:id/analyses` creates and reports as `running`, `succeeded` or `failed`. Exposing
those as three or four polling protocols would mean a model has to know which kind of thing it started
before it can ask whether it finished, and the first tool it gets wrong is the deploy it forgot to watch.

So there is one `operation_id`, prefixed by kind, and one `get_operation`. The prefix keeps the handle
self-describing without making the model pass two fields that have to agree: `op_deploy_<uuid>` is a
`jobs` id, `op_loadtest_<uuid>` is a `loadtest_runs` id, and a malformed handle is an
`invalid_argument` rather than a lookup against the wrong table. Every substrate is mapped onto the same
five statuses, which are the ones `jobs` already uses, and the mapping is one table in one module rather
than a branch per tool.

**Polling needs a cursored JSON read, which the deploy epic does not have.** #111 exposes progress as
SSE at `GET /experiments/:id/events`, replaying from `Last-Event-ID`, which is right for a browser that
stays connected and wrong here: answering one poll by opening an event stream means holding a connection
per call and guessing when to stop reading. The queue already has `readEvents(jobId, afterId)`. This
issue adds the JSON route over it, `GET /experiments/:id/jobs/:jobId`, returning the job's status plus
the events after a cursor. That is additive; the SSE route keeps its browser.

**Why not the MCP tasks extension.** The 2026-07-28 specification has one, and it is a better fit for a
long call in the abstract. It was rejected for two reasons. Client support is optional, so a server that
only speaks tasks is a server that some editors cannot deploy from at all, and this epic's whole point
is that an editor can. More importantly a task is scoped to the connection that created it, while these
operations outlive any connection and are watched from the web application too: the deploy an agent
started has to be visible on the experiment page, and the handle an agent holds has to survive its
editor restarting. A row in Postgres does both. Tasks can be added later as a second way to observe the
same operation, which is the right order.

Cross-references: the confirmation token every spending or destroying tool requires is
`050-mcp-destructive-tool-guardrail.md`. The TTL and budget reaper in
`docs/issues/epic-9-deploy/050-ttl-and-budget-reaper.md` may destroy a stack while an agent holds a
handle to it, which is why a terminal operation reports why it ended rather than only that it did.

Spec: https://modelcontextprotocol.io/specification/2026-07-28/server/tools

### Contract

```python
# services/brain/src/brain/mcp/lifecycle/handles.py
class OperationKind(StrEnum):
    ANALYSIS = "analysis"   # analyses row
    DEPLOY = "deploy"       # jobs row, kind deploy.experiment
    DESTROY = "destroy"     # jobs row, kind deploy.destroy
    LOADTEST = "loadtest"   # loadtest_runs row


#: op_<kind>_<uuid>. Self-describing so one tool can poll four substrates, and
#: parseable so a wrong handle is rejected before any query runs.
HANDLE_PATTERN = r"^op_(analysis|deploy|destroy|loadtest)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


def format_handle(kind: OperationKind, row_id: UUID) -> str: ...
def parse_handle(handle: str) -> tuple[OperationKind, UUID]:
    """Raises ToolFailure('invalid_argument') on anything else."""


class OperationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class OperationHandle(BaseModel):
    operation_id: str
    kind: OperationKind
    status: OperationStatus
    experiment_id: UUID | None      # None for a repository analysis
    repository_id: UUID | None      # set for a repository analysis
    #: How long to wait before calling get_operation again. Grows with the age of
    #: the operation so a twelve-minute load test is not polled 700 times.
    poll_after_ms: int
    #: What this kind usually takes, so a model can decide whether to wait or to
    #: do something else. Stated per kind, not measured per call.
    typical_duration_ms: int
    progress: float | None          # 0..1 from job_events, or the ramp stage
    message: str | None
    started_at: datetime | None
    finished_at: datetime | None
    #: Newest last, after `after_cursor`. Empty for kinds with no event stream.
    events: list[OperationEvent]
    next_cursor: int | None
    #: Set once, on a terminal status. Shape depends on kind and is declared in
    #: the tool's outputSchema.
    result: dict[str, object] | None
    #: Present on FAILED. Carries the reason verbatim where there is one: a
    #: CodeBuild phase, or an ECS stoppedReason for a Spot interruption.
    error: OperationError | None


POLL_AFTER_MS: Mapping[OperationKind, tuple[int, int]] = {
    OperationKind.ANALYSIS: (1_000, 5_000),
    OperationKind.DEPLOY: (3_000, 15_000),
    OperationKind.DESTROY: (3_000, 15_000),
    OperationKind.LOADTEST: (10_000, 30_000),
}
```

The tools. Each is registered by `010-mcp-server-skeleton.md`'s server only when the process token
carries its scope, so an agent given a read-only token does not see a deploy tool at all:

```python
# services/brain/src/brain/mcp/lifecycle/tools.py
async def analyse_repository(
    repository_id: UUID, ref: str | None = None
) -> OperationHandle:
    """Analyse a connected repository and produce an AppProfile.

    Requires scope repository:analyse. Forwards to POST /repositories/:id/analyses.
    A 409 means an analysis is already running: the handle for that one is
    returned rather than a second analysis started.
    """


async def deploy(experiment_id: UUID, confirmation_token: str) -> OperationHandle:
    """Deploy the experiment's current architecture to the connected AWS account.

    Requires scope deploy:write and a token from preview_deploy. Forwards to
    POST /experiments/:id/deploy. A 409 returns the live deploy's handle.
    """


async def run_load_test(
    experiment_id: UUID, confirmation_token: str, target_rps: int | None = None
) -> OperationHandle:
    """Run the generated k6 ramp against the deployed stack.

    Requires scope loadtest:write and a token from preview_load_test. Forwards to
    the start route #70 defines. target_rps overrides the predicted rate the
    default ramp is built from.
    """


async def stop_load_test(operation_id: str, reason: str) -> OperationHandle:
    """Stop a running load test. Requires scope loadtest:write. No confirmation:
    stopping spends nothing and destroys nothing."""


async def destroy(experiment_id: UUID, confirmation_token: str) -> OperationHandle:
    """Destroy everything this experiment deployed.

    Requires scope destroy:write and a token from preview_destroy. Forwards to
    POST /experiments/:id/destroy, which returns the previous sweep when there is
    nothing left to destroy; that arrives as status succeeded with the earlier
    result rather than as an error.
    """


async def get_operation(operation_id: str, after_cursor: int | None = None) -> OperationHandle:
    """Poll any operation this user started, including ones started in the web
    application. Requires the scope the operation's kind required to start."""


async def get_load_test_results(experiment_id: UUID) -> LoadTestReport:
    """The predicted-versus-measured report from #72.

    Requires scope loadtest:write. Reads GET /experiments/:id/loadtest/report and
    fails not_found while no run has completed, because a report of a run that is
    still ramping would be read as a result.
    """
```

The client. One place knows how to reach `apps/api`, and it never holds a credential of its own:

```python
# services/brain/src/brain/mcp/lifecycle/api_client.py
class ApiClient:
    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None: ...

    async def post(self, path: str, *, bearer: str, json: dict[str, object]) -> ApiResponse:
        """Forwards the caller's PAT. Never sends a service credential, because
        this process is not authorised to act as anybody by itself."""


#: Start calls are short: the route enqueues and returns 202. A start that takes
#: longer than this is a failure to report, not something to wait out.
START_TIMEOUT_S = 10.0
```

Status mapping, stated once so no tool decides it privately:

| Substrate                | Source of truth                                         | Terminal `result`                                     |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| `analyses`               | `GET /repositories/:id/analyses`, matched by row id     | `profile_summary`, `component_count`, `analysis_id`   |
| `jobs` (deploy, destroy) | `GET /experiments/:id/jobs/:jobId`, events after cursor | deploy: `outputs`, `endpoint_url`; destroy: the sweep |
| `loadtest_runs`          | the poll route from #70, which reconciles with ECS      | `run_id`, `status`, `stopped_reason`                  |

A `loadtest_runs` row in status `queued` or `running` maps to the same names; anything ECS reports as a
Spot interruption arrives as `error.reason` verbatim rather than as a generic failure, because #70
retries on `FARGATE` and a model that cannot tell an interruption from a broken target will draw the
wrong conclusion about the architecture.

`get_operation` resolves ownership in the SQL that reads the row, never afterwards. `jobs` carries
`experiment_id`, so one join answers it for three of the four kinds:

```sql
-- deploy and destroy
SELECT j.* FROM jobs j
  JOIN experiments e ON e.id = j.experiment_id
 WHERE j.id = %(job_id)s AND e.user_id = %(user_id)s AND j.kind = %(kind)s;

-- repository analysis
SELECT a.* FROM analyses a
  JOIN repositories r ON r.id = a.repository_id
 WHERE a.id = %(analysis_id)s AND r.user_id = %(user_id)s;

-- load test
SELECT l.* FROM loadtest_runs l
  JOIN experiments e ON e.id = l.experiment_id
 WHERE l.id = %(run_id)s AND e.user_id = %(user_id)s;
```

No new table records who started an operation. Deriving the owner from the resource means a handle to a
deploy started in the browser polls exactly like one started here, which is the behaviour this epic
wants, and it removes a second copy of an ownership fact that could disagree with the first. A miss is
`not_found` whatever the reason.

### Files

- CREATE `services/brain/src/brain/mcp/lifecycle/__init__.py`
- CREATE `services/brain/src/brain/mcp/lifecycle/handles.py` - kinds, handle format, status mapping
- CREATE `services/brain/src/brain/mcp/lifecycle/api_client.py`
- CREATE `services/brain/src/brain/mcp/lifecycle/store.py` - the four scoped reads above
- CREATE `services/brain/src/brain/mcp/lifecycle/tools.py`
- CREATE `apps/api/src/routes/experiments/jobs.ts` - `GET /experiments/:id/jobs/:jobId`, status plus
  events after a cursor
- CREATE `apps/api/src/routes/experiments/jobs.integration.test.ts`
- CREATE `services/brain/tests/test_mcp_lifecycle_handles.py`
- CREATE `services/brain/tests/test_mcp_lifecycle_tools.py`
- CREATE `services/brain/tests/test_mcp_lifecycle_scoping.py`
- MODIFY `services/brain/src/brain/mcp/server.py` - register the lifecycle tools, put the `ApiClient`
  in the lifespan context
- MODIFY `services/brain/src/brain/settings.py` - `api_base_url`
- MODIFY `apps/api/src/routes/experiments/index.ts` - mount the jobs route at a mount point beside the
  ones `docs/issues/epic-11-web/050-experiment-rest-api.md` establishes, behind its existing
  `require-experiment.ts` ownership guard
- MODIFY `services/brain/README.md` - the lifecycle tools and the polling contract

### Acceptance Criteria

- [ ] Every lifecycle tool returns within `START_TIMEOUT_S` and never waits for the operation to finish, asserted against a route stub that sleeps past the timeout
- [ ] `deploy`, `run_load_test` and `destroy` refuse a missing or invalid `confirmation_token` before any HTTP call is made
- [ ] A tool whose scope the token lacks is absent from `tools/list`, and calling it by name fails `insufficient_scope`
- [ ] `deploy` on an experiment already deploying returns the live operation's handle with `status: running` rather than starting a second deploy or failing
- [ ] Ten `deploy` calls in a loop against one experiment produce exactly one `jobs` row
- [ ] `analyse_repository` on a repository already being analysed returns the running analysis's handle
- [ ] `destroy` on an experiment with nothing deployed returns `succeeded` carrying the previous sweep, not an error
- [ ] `get_operation` returns the same handle shape for all four kinds, asserted by validating each against one model
- [ ] `get_operation` on a handle for another user's experiment or repository is `not_found`, indistinguishable from an unknown id
- [ ] `get_operation` polls a deploy that was started in the web application, with no row created by this server
- [ ] A malformed or wrong-prefix handle is `invalid_argument` and issues no query
- [ ] `after_cursor` returns only events after it, and the same cursor twice returns nothing new
- [ ] `poll_after_ms` increases as the operation ages, within the per-kind bounds
- [ ] A Spot-interrupted load test reports the ECS `stoppedReason` verbatim in `error.reason`
- [ ] A stack destroyed by the TTL reaper while an operation was held reports `failed` with the reaper's reason rather than a bare timeout
- [ ] `get_load_test_results` fails `not_found` while the run is still ramping and succeeds once the report artifact exists
- [ ] No lifecycle module imports an AWS SDK, asserted by a test that walks the imports
- [ ] The brain never sends a credential of its own to `apps/api`, asserted by a stub that fails any request whose bearer is not the caller's PAT

### Required Tests

- `test_every_lifecycle_tool_returns_a_handle_without_waiting`
- `test_destructive_tools_refuse_a_missing_confirmation_token`
- `test_out_of_scope_tools_are_not_listed_and_cannot_be_called`
- `test_deploy_while_deploying_returns_the_live_handle`
- `test_a_deploy_loop_creates_one_job`
- `test_analyse_while_analysing_returns_the_running_handle`
- `test_destroy_with_nothing_deployed_succeeds_with_the_previous_sweep`
- `test_all_four_kinds_validate_against_one_handle_model`
- `test_get_operation_refuses_another_users_operation`
- `test_get_operation_polls_a_browser_started_deploy`
- `test_a_malformed_handle_is_rejected_before_any_query`
- `test_event_cursor_returns_each_event_once`
- `test_poll_after_ms_backs_off_within_the_kind_bounds`
- `test_spot_interruption_is_reported_verbatim`
- `test_reaper_destroyed_stack_reports_the_reason`
- `test_load_test_results_are_absent_until_the_run_finishes`
- `test_no_lifecycle_module_imports_an_aws_sdk`
- `test_the_brain_forwards_the_callers_token_and_no_other`

### Performance Budget

Every start tool returns in under 500 ms against a warm `apps/api`, since it does one scope check, one
confirmation consume and one HTTP POST that itself only enqueues. `get_operation` completes in under
80 ms: one indexed row read plus a bounded `job_events` slice, capped at 200 events per call so a
noisy deploy cannot return a megabyte to a model. The load test poll is the exception and is allowed
1.5 s, because #70's poll reconciles with ECS `DescribeTasks`; `poll_after_ms` for that kind starts at
10 s so the reconcile is not the dominant cost of watching a run. No tool holds a database connection
across an HTTP call.

### Out of Scope

- Do not implement deploy, destroy, load test or analysis logic in Python, and do not add an AWS SDK to
  `services/brain`. The implementations are in `apps/api` next to the credentials and stay there
- Do not add a service credential, an internal API key or an act-as-user header. The caller's token is
  the only authority this server has
- Do not change the SSE route in #111. The JSON polling route is additive and the browser keeps its
  stream
- Do not implement the MCP tasks extension. It can be added later as a second way to observe the same
  operation
- Do not add a cancel tool for deploy or destroy. Cancelling a half-applied Pulumi run is a question for
  the epic that owns the deploy handler, not a tool schema decision
- Do not stream logs through MCP. `get_operation` returns a bounded slice after a cursor, and the full
  build log is CloudWatch's, reached through the deploy epic's own surfaces
- Do not create a table that records which token started an operation. Ownership derives from the
  experiment or repository, and 050 already records the confirmation that authorised it
- Do not let a tool retry a failed deploy automatically. A retry is a new operation a model asks for,
  and a spending action taken without being asked is what 050 exists to prevent

### Dependencies

Blocked by `010-mcp-server-skeleton.md`, `020-mcp-authentication-and-scoping.md` for the `Principal`,
the scopes and the `apps/api` bearer authenticator, and `050-mcp-destructive-tool-guardrail.md` for the
confirmation tokens the three spending tools require. Blocked by #28 for `jobs`, `job_events` and
`readEvents`, #111 for `POST /experiments/:id/deploy` and the `deploy.experiment` handler, #112 for
`POST /experiments/:id/destroy` and `deploy.destroy`, #70 for `loadtest_runs` and the start, poll and
stop routes, and #72 for the report route. Blocked by
`docs/issues/epic-11-web/010-connect-and-analyse-a-repository.md` for
`POST /repositories/:id/analyses` and the `analyses` table, and by
`docs/issues/epic-11-web/050-experiment-rest-api.md` for the experiments router the jobs route mounts
into. Where a route path or request body in #70 differs from what is assumed here, take it from that
issue rather than changing it.

### Verification

```bash
pnpm --filter @infracanvas/api test
pnpm --filter @infracanvas/api typecheck
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
pnpm db:migrate && uv run --directory services/brain pytest -m integration
curl -sS -H "Authorization: Bearer $IC_PAT" \
  "$API_BASE_URL/experiments/$EXPERIMENT_ID/jobs/$JOB_ID?afterCursor=0" | jq '.status, (.events|length)'
```

### Risk Tier

tier:1 - deploys and destroys infrastructure in a user's AWS account

### Size

size:l - over 600 lines
