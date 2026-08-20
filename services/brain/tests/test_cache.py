"""Content-hash cache keys and per-user isolation."""

from __future__ import annotations

import os
from uuid import uuid4

import pytest
from pydantic_ai.messages import ModelRequest, UserPromptPart

from brain import db
from brain.llm.cache import cache_key, lookup, store
from brain.llm.providers import ProviderCredential
from brain.profile import models as profile_models


def _credential(*, model: str = "gpt-4.1") -> ProviderCredential:
    return ProviderCredential(
        provider="openai",
        model=model,
        api_key="sk-test",
        base_url=None,
    )


def _messages(text: str = "analyse this repo") -> list[ModelRequest]:
    return [ModelRequest(parts=[UserPromptPart(content=text)])]


def test_cache_key_changes_with_the_reasoning_scale() -> None:
    user_id = uuid4()
    credential = _credential()
    messages = _messages()
    fast = cache_key(user_id, credential, "fast", messages, "profile-v1")
    thorough = cache_key(user_id, credential, "thorough", messages, "profile-v1")
    assert fast != thorough


def test_cache_key_changes_with_the_profile_schema_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = uuid4()
    credential = _credential()
    messages = _messages()
    before = cache_key(user_id, credential, "balanced", messages, "profile-v1")
    monkeypatch.setattr(profile_models, "PROFILE_SCHEMA_VERSION", 99)
    after = cache_key(user_id, credential, "balanced", messages, "profile-v1")
    assert before != after


@pytest.mark.integration
async def test_never_returns_another_users_cached_response() -> None:
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")

    db._pool = None
    from brain.settings import load_settings

    pool = await db.open_pool(load_settings())
    user_a = uuid4()
    user_b = uuid4()
    credential = _credential()
    messages = _messages("identical private source")

    async with pool.connection() as conn:
        for user_id, username in ((user_a, "cache-a"), (user_b, "cache-b")):
            await conn.execute(
                """
                INSERT INTO users (id, github_id, github_username, github_avatar)
                VALUES (%(id)s, %(github_id)s, %(username)s, 'https://example.com/a.png')
                """,
                {
                    "id": user_id,
                    "github_id": user_id.int % 2_000_000_000,
                    "username": f"{username}-{user_id.hex[:6]}",
                },
            )

    try:
        key_a = cache_key(user_a, credential, "balanced", messages, "profile-v1")
        key_b = cache_key(user_b, credential, "balanced", messages, "profile-v1")
        assert key_a != key_b

        await store(
            key_a,
            credential,
            {"findings": ["secret"]},
            10,
            20,
            user_id=user_a,
            reasoning="balanced",
        )

        assert await lookup(key_a) is not None
        assert await lookup(key_b) is None
    finally:
        async with pool.connection() as conn:
            await conn.execute(
                "DELETE FROM users WHERE id = ANY(%(ids)s)",
                {"ids": [user_a, user_b]},
            )
