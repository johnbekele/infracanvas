"""Per-user content-hash cache for LLM responses."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Literal
from uuid import UUID

from pydantic_ai.messages import ModelMessage

from brain.db import open_pool
from brain.llm.providers import ProviderCredential
from brain.settings import load_settings

ReasoningScale = Literal["fast", "balanced", "thorough"]


@dataclass(frozen=True, slots=True)
class CachedResponse:
    response: object
    input_tokens: int
    output_tokens: int
    user_id: UUID


def _stable_messages(messages: Sequence[ModelMessage]) -> list[dict[str, object]]:
    """Encode messages without volatile fields (timestamps, run ids)."""
    encoded: list[dict[str, object]] = []
    for message in messages:
        parts: list[dict[str, object]] = []
        for part in getattr(message, "parts", []):
            content = getattr(part, "content", None)
            kind = getattr(part, "part_kind", None) or type(part).__name__
            parts.append({"kind": kind, "content": content})
        kind = getattr(message, "kind", None) or type(message).__name__
        encoded.append({"kind": kind, "parts": parts})
    return encoded


def cache_key(
    user_id: UUID,
    credential: ProviderCredential,
    scale: ReasoningScale,
    messages: Sequence[ModelMessage],
    prompt_version: str,
) -> str:
    """SHA-256 over a canonical JSON encoding of every argument, with sorted
    keys. PROFILE_SCHEMA_VERSION is folded in, so a schema bump invalidates
    every entry without a manual purge."""
    # Imported lazily to avoid a circular import through brain.profile.__init__.
    from brain.profile.models import PROFILE_SCHEMA_VERSION

    payload = {
        "user_id": str(user_id),
        "provider": credential.provider,
        "model": credential.model,
        "reasoning": scale,
        "messages": _stable_messages(messages),
        "prompt_version": prompt_version,
        "profile_schema_version": PROFILE_SCHEMA_VERSION,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def lookup(key: str) -> CachedResponse | None:
    """Return a cached response and bump its hit counters, or None."""
    settings = load_settings()
    pool = await open_pool(settings)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            UPDATE llm_response_cache
            SET hit_count = hit_count + 1,
                last_hit_at = now()
            WHERE cache_key = %(key)s
            RETURNING user_id, response, input_tokens, output_tokens
            """,
            {"key": key},
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    return CachedResponse(
        user_id=UUID(str(row[0])),
        response=row[1],
        input_tokens=int(row[2]),
        output_tokens=int(row[3]),
    )


async def store(
    key: str,
    credential: ProviderCredential,
    response: object,
    input_tokens: int,
    output_tokens: int,
    *,
    user_id: UUID,
    reasoning: ReasoningScale,
) -> None:
    """Persist a response under the content hash. user_id is part of the key
    and is stored so a row can never be served across users."""
    settings = load_settings()
    pool = await open_pool(settings)
    payload = json.loads(json.dumps(response, default=str))
    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO llm_response_cache (
              cache_key, user_id, provider, model, reasoning,
              response, input_tokens, output_tokens
            )
            VALUES (
              %(key)s, %(user_id)s, %(provider)s, %(model)s, %(reasoning)s,
              %(response)s::jsonb, %(input_tokens)s, %(output_tokens)s
            )
            ON CONFLICT (cache_key) DO UPDATE SET
              response = EXCLUDED.response,
              input_tokens = EXCLUDED.input_tokens,
              output_tokens = EXCLUDED.output_tokens
            """,
            {
                "key": key,
                "user_id": user_id,
                "provider": credential.provider,
                "model": credential.model,
                "reasoning": reasoning,
                "response": json.dumps(payload),
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            },
        )


async def prune(older_than: timedelta) -> int:
    """Delete cache rows older than the given age. Returns how many were removed."""
    settings = load_settings()
    pool = await open_pool(settings)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            DELETE FROM llm_response_cache
            WHERE created_at < now() - %(age)s::interval
            """,
            {"age": older_than},
        )
    return int(cursor.rowcount or 0)
