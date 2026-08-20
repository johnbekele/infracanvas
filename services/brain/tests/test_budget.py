"""Token budget reservation and settlement."""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from brain import db
from brain.llm.budget import BudgetExceededError, month_to_date, reserve, settle
from brain.llm.providers import ProviderCredential
from brain.settings import load_settings

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _requires_database() -> None:
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")


@pytest.fixture(autouse=True)
def _reset_pool() -> None:
    db._pool = None


def _credential() -> ProviderCredential:
    return ProviderCredential(
        provider="openai",
        model="gpt-4.1",
        api_key="sk-test",
        base_url=None,
    )


async def _insert_user(*, budget: int | None) -> UUID:
    pool = await db.open_pool(load_settings())
    user_id = uuid4()
    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO users (id, github_id, github_username, github_avatar)
            VALUES (%(id)s, %(github_id)s, %(username)s, 'https://example.com/a.png')
            """,
            {
                "id": user_id,
                "github_id": user_id.int % 2_000_000_000,
                "username": f"budget-{user_id.hex[:8]}",
            },
        )
        if budget is not None:
            await conn.execute(
                """
                INSERT INTO user_settings (user_id, monthly_token_budget)
                VALUES (%(user_id)s, %(budget)s)
                """,
                {"user_id": user_id, "budget": budget},
            )
    return user_id


async def _delete_user(user_id: UUID) -> None:
    pool = await db.open_pool(load_settings())
    async with pool.connection() as conn:
        await conn.execute("DELETE FROM users WHERE id = %(id)s", {"id": user_id})


async def test_rejects_a_call_that_would_exceed_the_monthly_budget() -> None:
    user_id = await _insert_user(budget=1_000)
    credential = _credential()
    try:
        await reserve(user_id, credential, "profile", 600, reasoning="balanced")
        with pytest.raises(BudgetExceededError) as raised:
            await reserve(user_id, credential, "profile", 600, reasoning="balanced")
        assert raised.value.budget_tokens == 1_000
        assert raised.value.used_tokens >= 600
        assert raised.value.resets_at.tzinfo is not None
    finally:
        await _delete_user(user_id)


async def test_concurrent_reservations_cannot_both_pass_the_same_check() -> None:
    user_id = await _insert_user(budget=1_000)
    credential = _credential()

    async def attempt() -> str:
        try:
            reservation_id = await reserve(
                user_id, credential, "profile", 600, reasoning="balanced"
            )
            return f"ok:{reservation_id}"
        except BudgetExceededError:
            return "exceeded"

    try:
        results = await asyncio.gather(attempt(), attempt())
        assert sorted(results)[0] == "exceeded"
        assert results.count("exceeded") == 1
        assert sum(1 for item in results if item.startswith("ok:")) == 1
    finally:
        await _delete_user(user_id)


async def test_previous_month_usage_does_not_count_towards_this_month() -> None:
    user_id = await _insert_user(budget=500)
    credential = _credential()
    pool = await db.open_pool(load_settings())
    try:
        last_month = datetime(2026, 7, 15, 12, 0, tzinfo=UTC)
        async with pool.connection() as conn:
            await conn.execute(
                """
                INSERT INTO llm_usage (
                  user_id, provider, model, reasoning, purpose,
                  estimated_tokens, input_tokens, output_tokens, created_at
                )
                VALUES (
                  %(user_id)s, 'openai', 'gpt-4.1', 'balanced', 'profile',
                  900, 900, 0, %(created_at)s
                )
                """,
                {"user_id": user_id, "created_at": last_month},
            )
        # This month's budget is still free despite last month's 900 tokens.
        reservation_id = await reserve(user_id, credential, "profile", 400, reasoning="balanced")
        assert reservation_id is not None
        summary = await month_to_date(user_id)
        assert summary.used_tokens == 400
        assert summary.budget_tokens == 500
    finally:
        await _delete_user(user_id)


async def test_settle_replaces_the_estimate_with_reported_counts() -> None:
    user_id = await _insert_user(budget=10_000)
    credential = _credential()
    pool = await db.open_pool(load_settings())
    try:
        reservation_id = await reserve(user_id, credential, "judge", 2_000, reasoning="fast")
        await settle(reservation_id, 120, 45)
        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                SELECT estimated_tokens, input_tokens, output_tokens
                FROM llm_usage WHERE id = %(id)s
                """,
                {"id": reservation_id},
            )
            row = await cursor.fetchone()
        assert row is not None
        assert row[0] == 2_000
        assert row[1] == 120
        assert row[2] == 45
        summary = await month_to_date(user_id)
        assert summary.used_tokens == 165
    finally:
        await _delete_user(user_id)
