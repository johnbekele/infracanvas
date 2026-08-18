"""Shared fixtures for the brain test suite."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from brain import db


@pytest.fixture(autouse=True)
def _reset_pool() -> Iterator[None]:
    """Each test starts with no pool so connection state cannot leak."""
    db._pool = None
    yield
    db._pool = None
