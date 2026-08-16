"""Profile tool guards: span width, path scope, and read budget."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from pydantic_ai import RunContext
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

from brain.profile.models import Citation
from brain.profile.tools import (
    MAX_READS,
    MAX_SPAN_LINES,
    ProfileDeps,
    ProfileToolError,
    read_span,
)


def _ctx(deps: ProfileDeps) -> RunContext[ProfileDeps]:
    return RunContext(
        deps=deps,
        model=TestModel(),
        usage=RunUsage(),
        prompt=None,
        messages=[],
    )


def _pool_returning(file_row: dict[str, Any] | None) -> AsyncMock:
    """Build an async pool whose connection/cursor returns the given file row."""
    cursor = AsyncMock()
    cursor.fetchone = AsyncMock(return_value=file_row)
    cursor.fetchall = AsyncMock(return_value=[])
    cursor.__aenter__ = AsyncMock(return_value=cursor)
    cursor.__aexit__ = AsyncMock(return_value=None)

    conn = AsyncMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    pool = AsyncMock()
    pool.connection = MagicMock(return_value=conn)
    return pool


async def test_read_span_rejects_an_over_wide_range() -> None:
    deps = ProfileDeps(repository_id=uuid4(), run_id=uuid4(), pool=_pool_returning(None))
    with pytest.raises(ProfileToolError, match="maximum is 200"):
        await read_span(
            _ctx(deps),
            "apps/api/db.py",
            1,
            MAX_SPAN_LINES + 1,
        )
    assert deps.reads == []


async def test_read_span_refuses_a_path_outside_the_run() -> None:
    deps = ProfileDeps(repository_id=uuid4(), run_id=uuid4(), pool=_pool_returning(None))
    with pytest.raises(ProfileToolError, match="not in this ingestion run"):
        await read_span(_ctx(deps), "secrets/other-repo.py", 1, 10)
    assert deps.reads == []


async def test_stops_after_the_read_budget_is_exhausted() -> None:
    deps = ProfileDeps(
        repository_id=uuid4(),
        run_id=uuid4(),
        pool=_pool_returning(
            {"id": uuid4(), "sha256": "cd" * 32},
        ),
        reads=[
            Citation(
                path=f"file-{index}.py",
                start_line=1,
                end_line=1,
                file_sha256="ab" * 32,
            )
            for index in range(MAX_READS)
        ],
    )
    with pytest.raises(ProfileToolError, match="Read budget exhausted"):
        await read_span(_ctx(deps), "apps/api/db.py", 1, 5)
    assert len(deps.reads) == MAX_READS
