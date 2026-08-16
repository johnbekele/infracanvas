---
title: '[brain] MCP server inside services/brain so tools are the copilot functions, not copies'
labels: tier:2, size:m, area:brain, epic:14-mcp
---

### Epic

#118

### Context

Epic 13 (#117) puts a tool surface over the Architecture IR and calls it from a chat panel in the web
application. This epic exposes the same surface to whatever coding agent the user already has open.
The single decision that makes the epic worth doing rather than dangerous is that there must be one
implementation of each tool, not two. A second implementation would drift, and the drift would not be
cosmetic: `apply_patch` accepting a slightly different edit shape over MCP than over the chat panel
means the canvas and the agent disagree about what a valid architecture is, and the disagreement is
discovered when a deploy generates Pulumi from a document nothing validated.

**So the MCP server is a Python package inside `services/brain`, and it serves epic 13's tool
registry.** `docs/issues/epic-13-agent/020-copilot-tool-surface.md` publishes `COPILOT_TOOLS` and says
of it that "040 registers from it, #118 serves from it" - the tools there are plain async functions
rather than framework closures precisely so that this epic can be a second caller instead of a second
implementation. The alternative considered and rejected was a separate TypeScript server under
`apps/mcp` that reaches the platform over HTTP. It fails the one-contract rule in whichever form it
takes. If it calls the existing REST routes, there are no routes for `propose_patch` or
`compare_options`, so it would have to assemble those behaviours from lower-level calls, which is a
second implementation by definition. If instead `apps/api` grows one HTTP endpoint per copilot tool,
the contract is now stated three times - in the Python signature, in the JSON body of the shim, and
in the MCP input schema - and only the third is checked by anything. Two of those three would be kept
in step by review, which is the mechanism that has already failed everywhere else in this repository
that had a property bag with no schema. Importing the callable means the contract is stated once and
the interpreter enforces it.

Two facts about the repository push the same way. The IR validator and its Pydantic models are
generated into `services/brain` by #78, so a TypeScript server would need a second IR type surface to
talk about architectures at all. And the tools that read code read `files` and `chunks` through the
retrieval stack in `services/brain`, which is Python. A TypeScript MCP server would end up calling
the brain for most of what it does, which is the same hop with an extra process in it.

The cost of the choice is real and is stated here rather than discovered later. `services/brain` is
today a FastAPI health endpoint and a lazily-opened `psycopg` pool - `src/brain/app.py`,
`src/brain/db.py`, `src/brain/settings.py` - with no authentication of any kind and no entry in
`docker-compose.yml`. It inherits nothing from `apps/api/src/middleware/auth.ts`, so
`020-mcp-authentication-and-scoping.md` has to build a principal from scratch.

The deploy, load test and destroy paths are the other half of that cost. They live in TypeScript in
`apps/api` next to the cross-account credentials, and epic 13 does not wrap them: its registry is the
six IR tools and nothing else, because a chat panel that prices an edit has no reason to deploy. So
this epic reaches them the way the browser does, over HTTP, forwarding the caller's own token;
`040-mcp-lifecycle-tools.md` owns that client and the reasoning for it, and no AWS SDK enters
`services/brain`.

**Transport is stdio only, and that is a decision rather than a first step.** The protocol defines
two standard bindings, stdio and Streamable HTTP. Over HTTP the specification requires an MCP server
to act as an OAuth 2.1 resource server and to publish OAuth 2.0 Protected Resource Metadata
(RFC 9728); a bearer personal access token would be a non-conformant shortcut that every conformant
client would fail to negotiate. Over stdio the specification says the opposite - implementations
"SHOULD NOT" follow the authorization flow and should retrieve credentials from the environment -
which is exactly the design in `020-mcp-authentication-and-scoping.md`. Shipping stdio first is
therefore the conformant choice for a token-authenticated server, and it also matches how this
platform is run: a self-hosted install has the database on the same machine, which is what a
subprocess server needs. Streamable HTTP is named in Out of Scope with the work it implies.

The version this was written against is pinned in code as `MCP_PROTOCOL_VERSION = "2026-07-28"`,
which is the current revision. That revision matters to the shape of this issue: it removed the
`initialize` handshake in favour of per-request `_meta` metadata, made `server/discover` a mandatory
RPC, and made the tool set allowed to vary by the authorization presented on the request. A reader
finding this file after the next revision lands should compare against that string rather than
assuming.

Spec: https://modelcontextprotocol.io/specification/2026-07-28, docs/DELIVERY.md

### Contract

The SDK is `mcp>=2.0,<3`, whose 2.0 line implements the 2026-07-28 revision. Nothing in this package
hand-rolls JSON-RPC.

```python
# services/brain/src/brain/mcp/manifest.py
"""Server identity and the protocol revision this package targets."""

#: The MCP revision every schema and message shape here was written against.
#: Bumping it is a reviewable change, not an implicit consequence of upgrading
#: the SDK, because the SDK supports several revisions at once.
MCP_PROTOCOL_VERSION = "2026-07-28"

SERVER_NAME = "infracanvas"

#: Returned from `server/discover` as `instructions`. Kept short: it is prepended
#: to a model's context on every session that reads it.
SERVER_INSTRUCTIONS = """\
InfraCanvas designs, prices and deploys AWS architectures for a GitHub repository.
Read an architecture before editing it. Tools that create, spend or destroy require a
confirmation token from the matching preview tool. Long operations return an operation
handle; poll get_operation rather than waiting."""
```

```python
# services/brain/src/brain/mcp/errors.py
class ToolFailure(Exception):
    """A failure the calling model can act on.

    Raised by tool bodies and turned into a tool result with `isError: true`
    rather than a JSON-RPC error, because the protocol reserves JSON-RPC errors
    for malformed requests and unknown tools - things a model cannot fix - and
    directs recoverable failures into the result so the model can read and
    retry them.
    """

    def __init__(self, code: ToolErrorCode, message: str, **detail: object) -> None: ...

    code: ToolErrorCode
    message: str
    detail: dict[str, object]


ToolErrorCode = Literal[
    "unauthenticated",       # no token, unknown token, revoked or expired
    "insufficient_scope",    # token is valid but lacks the scope this tool needs
    "not_found",             # the object does not exist, or is not this user's
    "invalid_argument",      # validated shape, unusable value
    "conflict",              # the object is in a state that forbids this call
    "confirmation_required", # a destructive tool called with no confirmation token
    "confirmation_invalid",  # expired, already used, or bound to a different plan
    "rate_limited",
    "unavailable",           # the database, the API or AWS could not be reached
]


class ToolError(BaseModel):
    """The `structuredContent` of a failed tool result."""

    code: ToolErrorCode
    message: str
    detail: dict[str, object] = Field(default_factory=dict)
```

Every failed result carries both a `TextContent` block holding `message` and a `structuredContent`
holding the `ToolError`, so a model reads prose and a client application branches on `code`. The
codes are a closed `Literal` rather than free strings because `050-mcp-destructive-tool-guardrail.md`
asserts on `confirmation_invalid` and a renamed string would silently turn that assertion into a
test of nothing.

```python
# services/brain/src/brain/mcp/server.py
@dataclass
class BrainMcpContext:
    """Yielded once by the lifespan and shared by every handler."""

    pool: AsyncConnectionPool
    settings: Settings
    #: Read once from INFRACANVAS_TOKEN at startup. None means the server runs
    #: and every tool call fails `unauthenticated`, which is a far better
    #: diagnostic than a process that refuses to start inside a host that hides
    #: subprocess stderr.
    token: str | None


@asynccontextmanager
async def mcp_lifespan(server: MCPServer) -> AsyncIterator[BrainMcpContext]: ...


def create_mcp_server() -> MCPServer:
    """Build the server and register every tool group.

    Deliberately a function rather than module-level state, so a test can build a
    server with a stub pool without importing a live database. Domain tools are
    not enumerated here: 030-mcp-architecture-tools.md registers by iterating
    epic 13's COPILOT_TOOLS, and this function calls its registrar.
    """
```

```python
# services/brain/src/brain/mcp/__main__.py
def main() -> int:
    """stdio entry point for the `brain-mcp` console script."""
```

`main` configures `logging` to stderr before constructing the server, because on stdio stdout is the
wire and a stray flushed `print` corrupts it.

`BrainMcpContext` is the one object every handler reads shared state from, and the later issues extend
it rather than opening their own connections: `030-mcp-architecture-tools.md` adds the preview client
epic 13's tools expect inside `CopilotDeps`, and `040-mcp-lifecycle-tools.md` adds the `apps/api`
client. Both are built once by the lifespan, because a per-call client would mean a new connection pool
per tool call.

Registration in this issue covers no domain tools. It registers exactly one, so the skeleton is
exercisable end to end:

```python
@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
async def server_info(ctx: Context[BrainMcpContext]) -> ServerInfo:
    """Report the server version, the protocol revision, and whether the database is reachable."""
```

```python
class ServerInfo(BaseModel):
    server_name: str
    server_version: str          # brain.__version__
    protocol_version: str        # MCP_PROTOCOL_VERSION
    database_reachable: bool     # brain.db.ping
    authenticated: bool          # a token was present and resolved
```

`server_info` reports `authenticated` rather than failing when no token is present, so the first
thing a user does after wiring the server up tells them which half is wrong.

Host configuration, documented in `services/brain/README.md`:

```json
{
  "mcpServers": {
    "infracanvas": {
      "command": "uv",
      "args": ["run", "--directory", "services/brain", "brain-mcp"],
      "env": {
        "DATABASE_URL": "postgres://infracanvas:infracanvas@localhost:5432/infracanvas",
        "INFRACANVAS_TOKEN": "ic_pat_..."
      }
    }
  }
}
```

The smoke test speaks the protocol rather than calling Python. It launches the console script as a
subprocess and writes newline-delimited JSON-RPC to its stdin:

```python
# services/brain/tests/test_mcp_protocol_smoke.py
@pytest.mark.integration
async def test_lists_tools_over_stdio() -> None:
    """Drive `brain-mcp` as a subprocess, exactly as a host does.

    Asserting through `mcp.Client(server)` would exercise the SDK's in-memory
    transport and prove nothing about the console script, the stdout hygiene
    rule, or the manifest a real host reads first.
    """
```

The two requests it sends, with the `_meta` the revision requires on every request:

```json
{
  "jsonrpc": "2.0",
  "id": "discover-1",
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "infracanvas-tests", "version": "0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

```json
{ "jsonrpc": "2.0", "id": "list-1", "method": "tools/list", "params": { "_meta": {} } }
```

and the response shape it asserts on: `result.supportedVersions` contains `2026-07-28`,
`result.capabilities.tools` is present, `result._meta["io.modelcontextprotocol/serverInfo"].name` is
`infracanvas`, and `tools/list` returns `server_info` with a valid JSON Schema `inputSchema` object.

The in-memory `Client` is still used, for everything else. It is the cheap path and the subprocess
test exists only to prove the wire:

```python
@pytest.fixture
async def client() -> AsyncIterator[Client]:
    async with Client(create_mcp_server(), raise_exceptions=True) as c:
        yield c
```

### Files

- CREATE `services/brain/src/brain/mcp/__init__.py`
- CREATE `services/brain/src/brain/mcp/manifest.py`
- CREATE `services/brain/src/brain/mcp/errors.py`
- CREATE `services/brain/src/brain/mcp/server.py`
- CREATE `services/brain/src/brain/mcp/__main__.py`
- CREATE `services/brain/tests/test_mcp_manifest.py`
- CREATE `services/brain/tests/test_mcp_errors.py`
- CREATE `services/brain/tests/test_mcp_server_info.py`
- CREATE `services/brain/tests/test_mcp_protocol_smoke.py`
- CREATE `services/brain/tests/conftest.py` - the `anyio_backend` and `client` fixtures
- MODIFY `services/brain/pyproject.toml` - add `mcp>=2.0,<3`, add `inline-snapshot` to the dev
  extra, declare `[project.scripts] brain-mcp = "brain.mcp.__main__:main"`
- MODIFY `services/brain/README.md` - what the server is, how to run it, the host configuration
  block above, and the protocol revision targeted

### Acceptance Criteria

- [ ] `brain-mcp` started as a subprocess answers `server/discover` with `supportedVersions` containing `2026-07-28` and a `capabilities.tools` object
- [ ] `tools/list` over that same subprocess returns `server_info` with an `inputSchema` that is a JSON Schema object, not `null`
- [ ] `tools/list` returns tools in the same order on two consecutive calls
- [ ] The server starts and answers `server/discover` with `DATABASE_URL` unset, reporting `database_reachable: false` from `server_info` rather than exiting
- [ ] The server starts and answers `tools/list` with `INFRACANVAS_TOKEN` unset, and `server_info` reports `authenticated: false`
- [ ] No byte reaches stdout except JSON-RPC messages; a `logging` call inside a tool body appears on stderr
- [ ] `tools/call` for a name that is not registered returns a JSON-RPC error with code `-32602`, not a result with `isError: true`
- [ ] A `ToolFailure` raised in a tool body becomes a result with `isError: true` whose `structuredContent` validates against `ToolError`
- [ ] A `ToolFailure` result carries the same message in its `TextContent` block and in `structuredContent.message`
- [ ] An unexpected exception in a tool body becomes an `isError: true` result whose message names no file path, no SQL and no connection string
- [ ] `MCP_PROTOCOL_VERSION` equals the version reported by `server/discover`, asserted by a test rather than by reading both
- [ ] `uv run --directory services/brain mypy src` passes with `strict = true` unchanged

### Required Tests

- `test_discover_reports_the_targeted_protocol_version`
- `test_lists_tools_over_stdio`
- `test_tool_order_is_stable_across_calls`
- `test_starts_without_a_database_url_and_reports_it`
- `test_starts_without_a_token_and_reports_it`
- `test_stdout_carries_only_jsonrpc_and_logging_goes_to_stderr`
- `test_unknown_tool_is_a_protocol_error_not_a_tool_error`
- `test_tool_failure_becomes_an_is_error_result_with_a_structured_code`
- `test_unexpected_exception_is_not_leaked_to_the_caller`
- `test_manifest_version_matches_the_discover_response`

### Performance Budget

Cold start from process launch to a `server/discover` response is under 1500 ms, measured in
`test_mcp_protocol_smoke.py`, because a host launches the subprocess while the user waits. That
budget forbids importing the retrieval or embedding stack at module scope; the lifespan opens only
the `psycopg` pool, which `brain.db` already opens lazily. `tools/list` completes in under 20 ms and
issues no database query at all - the tool set is a function of the token's scopes, and the token is
read once at startup. Resident set after startup stays under 120 MB.

### Out of Scope

- Do not implement the Streamable HTTP transport. It obliges the server to be an OAuth 2.1 resource
  server publishing RFC 9728 Protected Resource Metadata, which is its own issue and its own security
  review, and a bearer personal access token over HTTP would be non-conformant
- Do not register the architecture, prediction or lifecycle tools; those are
  `030-mcp-architecture-tools.md` and `040-mcp-lifecycle-tools.md`, and a skeleton that already
  carries them cannot be reviewed on its own
- Do not implement authentication or scope checks beyond reading `INFRACANVAS_TOKEN` into
  `BrainMcpContext` and reporting whether it resolved; `020-mcp-authentication-and-scoping.md` owns
  the token and the principal
- Do not implement MCP prompts, completions, subscriptions, or the `io.modelcontextprotocol/tasks`
  extension. Tasks in particular is negotiated per request and must not be returned to a client that
  did not declare it; `040-mcp-lifecycle-tools.md` records why the explicit job handle comes first
- Do not modify `services/brain/src/brain/app.py` or the health router. The MCP server is a second
  entry point into the same package, not a change to the HTTP service
- Do not add `services/brain` to `docker-compose.yml`. It is genuinely missing, and adding it is a
  change to how the whole stack starts rather than a consequence of this package existing
- Do not add general request rate limiting. A stdio server serves one process holding one token from
  its own environment, so there is no online guessing surface here; the minting route in
  `020-mcp-authentication-and-scoping.md` is behind the existing limiter in
  `apps/api/src/middleware/rate-limit.ts`

### Dependencies

Blocked by #30 for the `uv` toolchain and the `services/brain` test layout. Depends on Epic 13
(#117) only from `030-mcp-architecture-tools.md` onwards; this issue registers no copilot tool and
can land before any epic-13 issue does.

### Verification

```bash
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest -m "not integration"
pnpm db:migrate && uv run --directory services/brain pytest -m integration
uv run --directory services/brain brain-mcp < /dev/null
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}' \
  | uv run --directory services/brain brain-mcp
```

The last command is the whole claim of this issue in one line: a real host does nothing more than
launch that process and write that JSON to it. `uv run mcp dev` is the interactive equivalent and is
documented in the README, but it needs `npx` and so is not part of the gate.

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
