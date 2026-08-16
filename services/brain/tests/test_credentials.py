"""Tests for loading the default LLM credential from Postgres."""

from __future__ import annotations

import os
import time
from uuid import uuid4

import pytest

from brain import db
from brain.llm.credentials import load_default_credential
from brain.llm.crypto import decrypt
from brain.llm.providers import MissingCredentialError, build_model
from brain.settings import Settings

# Same fixture key shape as the TypeScript API: 64 hex characters.
_ENCRYPTION_KEY = "a" * 64


def _encrypt_for_test(plaintext: str) -> str:
    """Produce the same envelope as apps/api/src/lib/encryption.ts."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    iv = os.urandom(12)
    key = bytes.fromhex(_ENCRYPTION_KEY)
    ciphertext_and_tag = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    ciphertext, tag = ciphertext_and_tag[:-16], ciphertext_and_tag[-16:]
    return f"{iv.hex()}:{tag.hex()}:{ciphertext.hex()}"


def _settings() -> Settings:
    return Settings(
        database_url=os.environ.get("DATABASE_URL"),
        environment="test",
        encryption_key=_ENCRYPTION_KEY,
        ollama_base_url="http://localhost:11434/v1",
    )


@pytest.fixture(autouse=True)
def _reset_pool() -> None:
    db._pool = None


@pytest.mark.integration
async def test_load_default_credential_follows_the_default_row() -> None:
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")

    settings = _settings()
    pool = await db.open_pool(settings)
    user_id = uuid4()

    openai_key = "sk-openai-default"
    anthropic_key = "sk-anthropic-alt"
    assert decrypt(_encrypt_for_test(openai_key), bytes.fromhex(_ENCRYPTION_KEY)) == openai_key

    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO users (id, github_id, github_username, github_avatar)
            VALUES (%(id)s, %(github_id)s, %(username)s, 'https://example.com/a.png')
            """,
            {
                "id": user_id,
                "github_id": user_id.int % 2_000_000_000,
                "username": f"brain-{user_id.hex[:8]}",
            },
        )
        await conn.execute(
            """
            INSERT INTO llm_credentials
              (user_id, provider, model, api_key_encrypted, key_hint, base_url, is_default)
            VALUES
              (%(user_id)s, 'openai', 'gpt-4.1', %(enc)s, 'ault', NULL, true),
              (%(user_id)s, 'anthropic', 'claude-sonnet-4-5', %(enc2)s, 't-alt', NULL, false)
            """,
            {
                "user_id": user_id,
                "enc": _encrypt_for_test(openai_key),
                "enc2": _encrypt_for_test(anthropic_key),
            },
        )

    # Warm the pool before the timed call.
    await db.ping(settings)

    started = time.perf_counter()
    first = await load_default_credential(user_id, settings)
    elapsed_ms = (time.perf_counter() - started) * 1000

    assert first.provider == "openai"
    assert first.model == "gpt-4.1"
    assert first.api_key == openai_key
    assert elapsed_ms < 10.0

    assert build_model(first, settings) is not None

    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE llm_credentials SET is_default = false
            WHERE user_id = %(user_id)s AND provider = 'openai'
            """,
            {"user_id": user_id},
        )
        await conn.execute(
            """
            UPDATE llm_credentials SET is_default = true
            WHERE user_id = %(user_id)s AND provider = 'anthropic'
            """,
            {"user_id": user_id},
        )

    second = await load_default_credential(user_id, settings)
    assert second.provider == "anthropic"
    assert second.model == "claude-sonnet-4-5"
    assert second.api_key == anthropic_key
    assert second.provider != first.provider

    async with pool.connection() as conn:
        await conn.execute("DELETE FROM users WHERE id = %(id)s", {"id": user_id})


@pytest.mark.integration
async def test_load_default_credential_maps_google_to_gemini() -> None:
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")

    settings = _settings()
    pool = await db.open_pool(settings)
    user_id = uuid4()
    api_key = "sk-google-gemini"

    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO users (id, github_id, github_username, github_avatar)
            VALUES (%(id)s, %(github_id)s, %(username)s, 'https://example.com/a.png')
            """,
            {
                "id": user_id,
                "github_id": user_id.int % 2_000_000_000,
                "username": f"brain-g-{user_id.hex[:8]}",
            },
        )
        await conn.execute(
            """
            INSERT INTO llm_credentials
              (user_id, provider, model, api_key_encrypted, key_hint, base_url, is_default)
            VALUES (%(user_id)s, 'google', 'gemini-2.5-flash', %(enc)s, 'mini', NULL, true)
            """,
            {"user_id": user_id, "enc": _encrypt_for_test(api_key)},
        )

    credential = await load_default_credential(user_id, settings)
    assert credential.provider == "gemini"
    assert credential.api_key == api_key

    async with pool.connection() as conn:
        await conn.execute("DELETE FROM users WHERE id = %(id)s", {"id": user_id})


@pytest.mark.integration
async def test_load_default_credential_raises_when_none_configured() -> None:
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is not set")

    settings = _settings()
    with pytest.raises(MissingCredentialError):
        await load_default_credential(uuid4(), settings)
