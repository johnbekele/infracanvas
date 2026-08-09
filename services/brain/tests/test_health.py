from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from brain import db
from brain.app import create_app
from brain.health import check_health
from brain.settings import Settings, load_settings


@pytest.fixture(autouse=True)
def _reset_pool() -> None:
    """Each test starts with no pool, so one test's connection state cannot
    decide another test's result."""
    db._pool = None


def test_app_starts_without_optional_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """The service must boot with no DATABASE_URL.

    A process that exits on a missing variable tells an operator nothing beyond
    "it is gone"; one that starts and reports `database: down` tells them what
    to fix.
    """
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 503


async def test_health_reports_503_when_database_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A routable address with nothing listening fails fast rather than waiting
    # for a DNS timeout.
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgres://nobody:nobody@127.0.0.1:1/none?connect_timeout=1",
    )

    result = await check_health(load_settings())

    assert result.status == "degraded"
    assert result.database == "down"


async def test_ping_is_false_without_a_configured_database() -> None:
    assert await db.ping(Settings(database_url=None, environment="test")) is False


def test_health_response_shape_matches_the_typescript_api() -> None:
    """Both services sit behind one probe configuration, so the payload keys
    must not drift apart."""
    from brain.health import HealthResponse

    assert set(HealthResponse.model_fields) == {"status", "database"}
