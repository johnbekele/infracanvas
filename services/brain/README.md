# brain

The analysis and generation service: repository understanding, retrieval, architecture proposals,
and Pulumi program generation.

This is Python rather than TypeScript because it is where the agent and machine-learning ecosystem
lives, and rewriting that ecosystem in another language to avoid a second runtime would cost far
more than running two.

Right now it is a skeleton: an application factory, a health endpoint, a database pool, and an MCP
server entry point. That is deliberate. It establishes the toolchain and turns on the Python halves
of Gates 2, 3, and 5, which until now logged "not present yet" and passed. Agents, retrieval, and
generation arrive in later epics on top of this.

## MCP server

`brain-mcp` is a stdio MCP server inside this package. It exists so coding agents talk to the same
Python tool functions the in-app copilot will use, rather than a second implementation over HTTP.
Transport is stdio only; the process reads `DATABASE_URL` and `INFRACANVAS_TOKEN` from its
environment. The protocol revision targeted is `2026-07-28` (`MCP_PROTOCOL_VERSION` in
`brain.mcp.manifest`).

```bash
uv run --directory services/brain brain-mcp
```

Host configuration (Cursor / Claude Desktop and similar):

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

Interactive inspection (needs `npx`):

```bash
uv run --directory services/brain mcp dev brain.mcp.server:create_mcp_server
```

## Working on it

```bash
uv sync --directory services/brain --all-extras
uv run --directory services/brain pytest
uv run --directory services/brain uvicorn brain.app:create_app --factory --reload
```

`uv` rather than Poetry or pip-tools: it resolves and installs an order of magnitude faster, which
matters when every pull request pays that cost, and `uv.lock` pins hashes so CI installs exactly
what you tested against.

## Engine parity test

The engine parity test compares the `ic_engine` Python extension against the `ic-engine` CLI. It
skips when the extension has not been built, so the regular Python suite still works without a Rust
toolchain.

```bash
maturin build -m crates/ic-engine/Cargo.toml --release
uv pip install --directory services/brain "$PWD"/target/wheels/ic_engine-*.whl
cargo build --bin ic-engine --release
PATH="$PWD/target/release:$PATH" uv run --directory services/brain pytest tests/test_engine_parity.py -v
```

## Local Ollama (no API key)

A contributor with no hosted key, and CI with no secrets, can exercise the whole agent path
against a local Ollama. The provider registry treats a missing key as expected for Ollama and
reads `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`).

```bash
# Install and start Ollama, then pull a model once:
#   ollama pull llama3.3
export OLLAMA_BASE_URL=http://localhost:11434/v1
# ENCRYPTION_KEY is only needed when reading encrypted rows from llm_credentials.
# Pure Ollama use needs neither ENCRYPTION_KEY nor a credentials row.
uv run --directory services/brain uvicorn brain.app:create_app --factory --reload
```

Point the default credential at provider `ollama` (or call `build_model` with an ollama
`ProviderCredential` and no `api_key`) and the service talks to the local daemon.

## Checks

These are the same commands the gates run, so a clean run here means a clean run there.

```bash
uv run --directory services/brain ruff format --check .
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy --strict src
uv run --directory services/brain pytest -m "not integration"
```

## Tests that need a database

Anything marked `@pytest.mark.integration` needs a live Postgres and is excluded from the unit test
gate. It skips rather than fails when `DATABASE_URL` is unset, so a clone with nothing installed
still gets a green run.

```bash
pnpm db:up
DATABASE_URL='postgres://infracanvas:infracanvas@localhost:5433/infracanvas?sslmode=disable' \
  uv run --directory services/brain pytest -m integration
```

## Health

`GET /health` returns `{"status": "ok", "database": "up"}`, or a 503 with `degraded` and `down` when
the database cannot serve a query. The payload matches the TypeScript API's `/health` so both
services can sit behind one probe configuration.

A missing `DATABASE_URL` is reported rather than fatal. A process that exits on boot tells an
operator nothing beyond "it is gone"; one that starts and reports `database: down` tells them what
to fix.

## Schema

Migrations are not owned here. The schema is shared with the TypeScript API and lives in
`db/migrations`, applied with dbmate. See `docs/DATABASE.md`.
