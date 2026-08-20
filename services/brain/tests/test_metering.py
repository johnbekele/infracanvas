"""MeteredRunner: budget refusal, cache hits, and agent.run ownership."""

from __future__ import annotations

import ast
import os
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.settings import ModelSettings

from brain import db
from brain.llm.budget import BudgetExceededError
from brain.llm.metering import MeteredRunner, estimate_tokens
from brain.llm.providers import ProviderCredential


class _Echo(BaseModel):
    text: str


def test_no_module_outside_metering_calls_agent_run() -> None:
    src_root = Path(__file__).resolve().parents[1] / "src" / "brain"
    metering = (src_root / "llm" / "metering.py").resolve()
    offenders: list[str] = []

    for path in src_root.rglob("*.py"):
        if path.resolve() == metering:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not isinstance(func, ast.Attribute) or func.attr != "run":
                continue
            # Match agent.run / profile_agent.run / self._agent.run, not meter.run
            # or runner.run. Attribute value must look like an agent binding.
            value = func.value
            name = ""
            if isinstance(value, ast.Name):
                name = value.id
            elif isinstance(value, ast.Attribute):
                name = value.attr
            if name.endswith("agent") or name == "_agent" or name == "agent":
                offenders.append(f"{path.relative_to(src_root)}:{node.lineno}")

    assert offenders == [], f"agent.run outside metering.py: {offenders}"


def test_estimate_tokens_is_pessimistic() -> None:
    assert estimate_tokens("abcd", 100) == 2 + 100  # ceil(4/3.5) == 2


@pytest.mark.integration
async def test_cache_hit_records_zero_tokens() -> None:
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")

    db._pool = None
    from brain.settings import load_settings

    pool = await db.open_pool(load_settings())
    user_id = uuid4()
    credential = ProviderCredential(
        provider="openai",
        model="gpt-4.1",
        api_key="sk-test",
        base_url=None,
    )

    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO users (id, github_id, github_username, github_avatar)
            VALUES (%(id)s, %(github_id)s, %(username)s, 'https://example.com/a.png')
            """,
            {
                "id": user_id,
                "github_id": user_id.int % 2_000_000_000,
                "username": f"meter-{user_id.hex[:8]}",
            },
        )
        await conn.execute(
            """
            INSERT INTO user_settings (user_id, monthly_token_budget)
            VALUES (%(user_id)s, %(budget)s)
            """,
            {"user_id": user_id, "budget": 100_000},
        )

    calls = {"count": 0}

    async def reply(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        calls["count"] += 1
        return ModelResponse(parts=[TextPart(content='{"text":"cached"}')])

    agent: Agent[None, _Echo] = Agent(output_type=_Echo)
    model = FunctionModel(reply)
    meter = MeteredRunner(
        model=model,
        model_settings=ModelSettings(max_tokens=128),
        credential=credential,
        scale="fast",
        prompt_version="test-v1",
        max_output_tokens=128,
    )

    try:
        first = await meter.run(agent, "same prompt", deps=None, purpose="profile", user_id=user_id)
        second = await meter.run(
            agent, "same prompt", deps=None, purpose="profile", user_id=user_id
        )
        assert first.text == "cached"
        assert second.text == "cached"
        assert calls["count"] == 1

        async with pool.connection() as conn:
            cursor = await conn.execute(
                """
                SELECT cache_hit, input_tokens, output_tokens
                FROM llm_usage
                WHERE user_id = %(user_id)s
                ORDER BY created_at
                """,
                {"user_id": user_id},
            )
            rows = await cursor.fetchall()
        assert len(rows) == 2
        assert rows[0][0] is False
        assert rows[1][0] is True
        assert rows[1][1] == 0
        assert rows[1][2] == 0
    finally:
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM users WHERE id = %(id)s", {"id": user_id})


@pytest.mark.integration
async def test_rejects_before_provider_when_budget_exhausted() -> None:
    """A call that would exceed the budget raises before any request reaches the
    provider. Named separately from the budget-module reject test so metering
    owns the 'no provider call' assertion."""
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")

    db._pool = None
    from brain.settings import load_settings

    pool = await db.open_pool(load_settings())
    user_id = uuid4()
    credential = ProviderCredential(
        provider="openai",
        model="gpt-4.1",
        api_key="sk-test",
        base_url=None,
    )

    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO users (id, github_id, github_username, github_avatar)
            VALUES (%(id)s, %(github_id)s, %(username)s, 'https://example.com/a.png')
            """,
            {
                "id": user_id,
                "github_id": user_id.int % 2_000_000_000,
                "username": f"refuse-{user_id.hex[:8]}",
            },
        )
        await conn.execute(
            """
            INSERT INTO user_settings (user_id, monthly_token_budget)
            VALUES (%(user_id)s, 50)
            """,
            {"user_id": user_id},
        )

    calls = {"count": 0}

    async def reply(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        calls["count"] += 1
        return ModelResponse(parts=[TextPart(content='{"text":"nope"}')])

    agent: Agent[None, _Echo] = Agent(output_type=_Echo)
    meter = MeteredRunner(
        model=FunctionModel(reply),
        model_settings=ModelSettings(max_tokens=128),
        credential=credential,
        scale="fast",
        prompt_version="test-v1",
        max_output_tokens=128,
    )

    try:
        with pytest.raises(BudgetExceededError):
            await meter.run(
                agent,
                "x" * 200,
                deps=None,
                purpose="profile",
                user_id=user_id,
            )
        assert calls["count"] == 0
    finally:
        async with pool.connection() as conn:
            await conn.execute("DELETE FROM users WHERE id = %(id)s", {"id": user_id})
