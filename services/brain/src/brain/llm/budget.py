"""Monthly token budget: reserve before the call, settle with real counts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from brain.db import open_pool
from brain.llm.providers import ProviderCredential
from brain.settings import load_settings


@dataclass(frozen=True, slots=True)
class UsageSummary:
    used_tokens: int
    budget_tokens: int | None
    resets_at: datetime


class BudgetExceededError(RuntimeError):
    used_tokens: int
    budget_tokens: int
    resets_at: datetime

    def __init__(self, used_tokens: int, budget_tokens: int, resets_at: datetime) -> None:
        self.used_tokens = used_tokens
        self.budget_tokens = budget_tokens
        self.resets_at = resets_at
        super().__init__(f"Monthly token budget exceeded: {used_tokens}/{budget_tokens}")


def month_resets_at(now: datetime | None = None) -> datetime:
    """First instant of the next calendar month in UTC."""
    current = now if now is not None else datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)
    else:
        current = current.astimezone(UTC)
    if current.month == 12:
        return datetime(current.year + 1, 1, 1, tzinfo=UTC)
    return datetime(current.year, current.month + 1, 1, tzinfo=UTC)


def _advisory_lock_key(user_id: UUID) -> int:
    # Postgres advisory locks take a signed bigint.
    return int(user_id.int % (2**63 - 1))


async def _load_budget(user_id: UUID) -> int | None:
    settings = load_settings()
    pool = await open_pool(settings)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT monthly_token_budget
            FROM user_settings
            WHERE user_id = %(user_id)s
            """,
            {"user_id": user_id},
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    budget = row[0]
    return int(budget) if budget is not None else None


async def _month_used(user_id: UUID) -> int:
    settings = load_settings()
    pool = await open_pool(settings)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT coalesce(sum(input_tokens + output_tokens), 0)
            FROM llm_usage
            WHERE user_id = %(user_id)s
              AND billing_month = (date_trunc('month', now() AT TIME ZONE 'UTC'))::date
            """,
            {"user_id": user_id},
        )
        row = await cursor.fetchone()
    return int(row[0]) if row is not None else 0


async def reserve(
    user_id: UUID,
    credential: ProviderCredential,
    purpose: str,
    estimated: int,
    *,
    reasoning: str = "balanced",
) -> UUID:
    """Insert a reservation row or raise BudgetExceededError. Returns its id.

    The pessimistic estimate is written into ``input_tokens`` as a hold so the
    month-to-date sum sees in-flight reservations. ``settle`` replaces that hold
    with the provider's reported counts. An advisory lock serialises concurrent
    checks for the same user so two requests cannot both pass the same total.
    """
    if estimated < 0:
        raise ValueError("estimated must be >= 0")

    budget = await _load_budget(user_id)
    settings = load_settings()
    pool = await open_pool(settings)

    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(%(lock_key)s)",
                {"lock_key": _advisory_lock_key(user_id)},
            )

            if budget is None:
                cursor = await conn.execute(
                    """
                    INSERT INTO llm_usage (
                      user_id, provider, model, reasoning, purpose,
                      estimated_tokens, input_tokens
                    )
                    VALUES (
                      %(user_id)s, %(provider)s, %(model)s, %(reasoning)s, %(purpose)s,
                      %(estimated)s, %(estimated)s
                    )
                    RETURNING id
                    """,
                    {
                        "user_id": user_id,
                        "provider": credential.provider,
                        "model": credential.model,
                        "reasoning": reasoning,
                        "purpose": purpose,
                        "estimated": estimated,
                    },
                )
            else:
                cursor = await conn.execute(
                    """
                    INSERT INTO llm_usage (
                      user_id, provider, model, reasoning, purpose,
                      estimated_tokens, input_tokens
                    )
                    SELECT %(user_id)s, %(provider)s, %(model)s, %(reasoning)s, %(purpose)s,
                           %(estimated)s, %(estimated)s
                    WHERE (
                      SELECT coalesce(sum(input_tokens + output_tokens), 0)
                      FROM llm_usage
                      WHERE user_id = %(user_id)s
                        AND billing_month =
                          (date_trunc('month', now() AT TIME ZONE 'UTC'))::date
                    ) + %(estimated)s <= %(budget)s
                    RETURNING id
                    """,
                    {
                        "user_id": user_id,
                        "provider": credential.provider,
                        "model": credential.model,
                        "reasoning": reasoning,
                        "purpose": purpose,
                        "estimated": estimated,
                        "budget": budget,
                    },
                )
            row = await cursor.fetchone()

    if row is None:
        if budget is None:
            raise RuntimeError("reservation failed without a configured budget")
        used = await _month_used(user_id)
        raise BudgetExceededError(used, budget, month_resets_at())

    return UUID(str(row[0]))


async def record_cache_hit(
    user_id: UUID,
    credential: ProviderCredential,
    purpose: str,
    reasoning: str,
) -> UUID:
    """Audit a cache hit: the call happened and cost nothing."""
    settings = load_settings()
    pool = await open_pool(settings)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            INSERT INTO llm_usage (
              user_id, provider, model, reasoning, purpose,
              estimated_tokens, input_tokens, output_tokens, cache_hit
            )
            VALUES (
              %(user_id)s, %(provider)s, %(model)s, %(reasoning)s, %(purpose)s,
              0, 0, 0, true
            )
            RETURNING id
            """,
            {
                "user_id": user_id,
                "provider": credential.provider,
                "model": credential.model,
                "reasoning": reasoning,
                "purpose": purpose,
            },
        )
        row = await cursor.fetchone()
    if row is None:
        raise RuntimeError("cache-hit usage row was not inserted")
    return UUID(str(row[0]))


async def settle(reservation_id: UUID, input_tokens: int, output_tokens: int) -> None:
    """Replace the estimate with the counts the provider reported."""
    if input_tokens < 0 or output_tokens < 0:
        raise ValueError("token counts must be >= 0")

    settings = load_settings()
    pool = await open_pool(settings)
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE llm_usage
            SET input_tokens = %(input_tokens)s,
                output_tokens = %(output_tokens)s
            WHERE id = %(id)s
            """,
            {
                "id": reservation_id,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
        )


async def month_to_date(user_id: UUID) -> UsageSummary:
    """Tokens spent this UTC calendar month, and the configured budget if any."""
    used = await _month_used(user_id)
    budget = await _load_budget(user_id)
    return UsageSummary(
        used_tokens=used,
        budget_tokens=budget,
        resets_at=month_resets_at(),
    )
