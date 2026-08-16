"""Load the user's default LLM credential and decrypt its key."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from brain.db import open_pool
from brain.llm.crypto import decrypt
from brain.llm.providers import (
    MissingCredentialError,
    ProviderCredential,
    ProviderId,
    UnknownProviderError,
)
from brain.settings import Settings

# The API stores Google as `google`; the registry names it `gemini`.
_DB_PROVIDER_ALIASES: dict[str, ProviderId] = {
    "google": "gemini",
}

_PROVIDER_IDS: frozenset[str] = frozenset(
    {
        "anthropic",
        "bedrock",
        "openai",
        "gemini",
        "ollama",
        "openai-compatible",
    }
)


def _parse_provider(raw: str) -> ProviderId:
    mapped = _DB_PROVIDER_ALIASES.get(raw, raw)
    if mapped not in _PROVIDER_IDS:
        raise UnknownProviderError(f"Unknown provider {raw!r}")
    return cast(ProviderId, mapped)


async def load_default_credential(user_id: UUID, settings: Settings) -> ProviderCredential:
    """Read the row #61 marks default for this user and decrypt its key.

    Raises MissingCredentialError when there is no default row, and when the
    stored ciphertext does not decrypt under the current ENCRYPTION_KEY.
    """
    pool = await open_pool(settings)
    async with pool.connection() as conn:
        cursor = await conn.execute(
            """
            SELECT provider, model, api_key_encrypted, base_url
            FROM llm_credentials
            WHERE user_id = %(user_id)s AND is_default
            LIMIT 1
            """,
            {"user_id": user_id},
        )
        record = await cursor.fetchone()

    if record is None:
        raise MissingCredentialError("No default LLM credential configured")

    provider_raw, model, encrypted_api_key, base_url = record
    provider = _parse_provider(str(provider_raw))

    api_key: str | None
    if encrypted_api_key:
        if not settings.encryption_key:
            raise MissingCredentialError("ENCRYPTION_KEY is not configured")
        try:
            key_bytes = bytes.fromhex(settings.encryption_key)
        except ValueError as error:
            raise MissingCredentialError("ENCRYPTION_KEY is not valid hex") from error
        api_key = decrypt(str(encrypted_api_key), key_bytes)
        if api_key is None:
            raise MissingCredentialError(
                "Stored API key could not be decrypted under ENCRYPTION_KEY"
            )
    else:
        api_key = None

    return ProviderCredential(
        provider=provider,
        model=str(model),
        api_key=api_key,
        base_url=str(base_url) if base_url is not None else None,
    )
