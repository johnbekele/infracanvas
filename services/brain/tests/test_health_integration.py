from __future__ import annotations

import os

import pytest

from brain.health import check_health
from brain.settings import load_settings

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _requires_database() -> None:
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")


async def test_health_reports_ok_when_database_reachable() -> None:
    result = await check_health(load_settings())

    assert result.status == "ok"
    assert result.database == "up"
