"""Shared fixtures for the brain test suite."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import pytest
from mcp.client import Client

from brain import db
from brain.mcp.server import create_mcp_server


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_pool() -> Iterator[None]:
    """Each test starts with no pool so connection state cannot leak."""
    db._pool = None
    yield
    db._pool = None


@pytest.fixture
async def client() -> AsyncIterator[Client]:
    async with Client(create_mcp_server(), raise_exceptions=True) as c:
        yield c
