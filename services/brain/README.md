# brain

The analysis and generation service: repository understanding, retrieval, architecture proposals,
and Pulumi program generation.

This is Python rather than TypeScript because it is where the agent and machine-learning ecosystem
lives, and rewriting that ecosystem in another language to avoid a second runtime would cost far
more than running two.

Right now it is a skeleton: an application factory, a health endpoint, and a database pool. That is
deliberate. It establishes the toolchain and turns on the Python halves of Gates 2, 3, and 5, which
until now logged "not present yet" and passed. Agents, retrieval, and generation arrive in later
epics on top of this.

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
