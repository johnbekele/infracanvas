---
title: '[ci] Python toolchain for services/brain with uv'
labels: tier:2, size:s, area:ci, epic:1-data
---

### Epic

#2

### Context

The agent runtime, the RAG orchestration, and the Pulumi generation are Python, and none of it can
start until there is a package to put it in and a CI job that checks it. Gates 2, 3, and 5 already
contain Python steps that currently log "services/brain not present yet" and pass; this issue makes
them real.

`uv` rather than Poetry or pip-tools: it resolves and installs an order of magnitude faster, which
matters when every pull request pays that cost, and it produces a lockfile that pins hashes so CI
installs exactly what a developer tested.

This issue creates the skeleton only. A FastAPI application with no routes and a passing test is
enough to prove the toolchain works, and keeps the diff reviewable.

Spec: `docs/DELIVERY.md`

### Contract

```toml
# services/brain/pyproject.toml
[project]
name = "brain"
requires-python = ">=3.12"
dependencies = ["fastapi", "uvicorn", "pydantic>=2", "psycopg[binary,pool]"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.mypy]
strict = true
warn_unreachable = true

[tool.pytest.ini_options]
addopts = "-q --strict-markers"
```

```python
# services/brain/src/brain/app.py
def create_app() -> FastAPI: ...

# services/brain/src/brain/health.py
async def health() -> HealthResponse: ...
```

`GET /health` returns `{"status": "ok", "database": "up" | "down"}` and a 503 when the database is
unreachable, matching the TypeScript API so both can sit behind the same probe configuration.

### Files

- CREATE `services/brain/pyproject.toml`
- CREATE `services/brain/uv.lock`
- CREATE `services/brain/src/brain/__init__.py`
- CREATE `services/brain/src/brain/app.py`
- CREATE `services/brain/src/brain/health.py`
- CREATE `services/brain/src/brain/db.py`
- CREATE `services/brain/tests/test_health.py`
- CREATE `services/brain/README.md`
- MODIFY `.github/workflows/gate-static.yml` - remove the "not present yet" notice path
- MODIFY `.github/workflows/gate-test.yml` - remove the "not present yet" notice path

### Acceptance Criteria

- [ ] `uv sync` installs from the committed lockfile without resolving
- [ ] `ruff check` and `ruff format --check` pass
- [ ] `mypy --strict` passes with no ignores
- [ ] `pytest` passes
- [ ] `GET /health` returns 200 with `database: up` against a live database
- [ ] `GET /health` returns 503 with `database: down` when the database is unreachable
- [ ] Gate 2 and Gate 3 run the Python steps for real rather than logging a notice

### Required Tests

- `test_health_reports_ok_when_database_reachable`
- `test_health_reports_503_when_database_unreachable`
- `test_app_starts_without_optional_environment`

### Performance Budget

`uv sync` from a warm cache completes in under 15 seconds on the CI runner. The health endpoint
responds in under 20ms.

### Out of Scope

- Do not add agents, LLM providers, or retrieval code; those are later epics
- Do not add an ORM or migration tooling; migrations stay with dbmate in `db/migrations`
- Do not add a Dockerfile or deployment configuration for this service yet

### Dependencies

Blocked by #22.

### Verification

```bash
uv sync --directory services/brain
uv run --directory services/brain ruff check .
uv run --directory services/brain ruff format --check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
