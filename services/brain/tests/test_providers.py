"""Unit tests for the pydantic-ai provider registry."""

from __future__ import annotations

import logging
import socket
import time
from typing import cast

import pytest
from pydantic_ai.models import Model

from brain.llm.providers import (
    MissingCredentialError,
    ProviderCredential,
    ProviderId,
    UnknownProviderError,
    build_model,
)
from brain.settings import Settings

_SETTINGS = Settings(
    database_url=None,
    environment="test",
    encryption_key=None,
    ollama_base_url="http://localhost:11434/v1",
)

_KEY = "sk-secret-test-key-do-not-leak"


def _credential(
    provider: ProviderId,
    *,
    api_key: str | None = _KEY,
    base_url: str | None = None,
    model: str = "test-model",
) -> ProviderCredential:
    return ProviderCredential(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
    )


@pytest.fixture
def socket_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail the test if build_model opens a TCP/UDP socket."""

    class _GuardedSocket(socket.socket):
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise AssertionError(f"build_model opened a socket: {args} {kwargs}")

    monkeypatch.setattr(socket, "socket", _GuardedSocket)


def test_builds_a_model_for_every_supported_provider(socket_guard: None) -> None:
    del socket_guard
    cases: list[ProviderCredential] = [
        _credential("anthropic", model="claude-sonnet-4-5"),
        _credential("bedrock", api_key=None, model="anthropic.claude-sonnet-4-5-v1:0"),
        _credential("openai", model="gpt-4.1"),
        _credential("gemini", model="gemini-2.5-flash"),
        _credential("ollama", api_key=None, model="llama3.3"),
        _credential(
            "openai-compatible",
            base_url="http://127.0.0.1:8080/v1",
            model="local-model",
        ),
    ]

    # Warm provider client construction so the budget measures build_model, not
    # first-import cost of the vendor SDKs behind pydantic-ai.
    for credential in cases:
        build_model(credential, _SETTINGS)

    for credential in cases:
        started = time.perf_counter()
        model = build_model(credential, _SETTINGS)
        elapsed_ms = (time.perf_counter() - started) * 1000
        assert isinstance(model, Model)
        assert elapsed_ms < 5.0, f"{credential.provider} took {elapsed_ms:.2f}ms"


def test_ollama_builds_without_an_api_key(socket_guard: None) -> None:
    del socket_guard
    settings = Settings(
        database_url=None,
        environment="test",
        ollama_base_url="http://127.0.0.1:11434/v1",
    )
    model = build_model(
        _credential("ollama", api_key=None, model="llama3.3"),
        settings,
    )
    assert isinstance(model, Model)


def test_bedrock_builds_without_a_stored_key(socket_guard: None) -> None:
    del socket_guard
    model = build_model(
        _credential("bedrock", api_key=None, model="anthropic.claude-sonnet-4-5-v1:0"),
        _SETTINGS,
    )
    assert isinstance(model, Model)


def test_unknown_provider_raises_rather_than_defaulting() -> None:
    credential = ProviderCredential(
        provider=cast(ProviderId, "cohere"),
        model="command-r",
        api_key=_KEY,
        base_url=None,
    )
    with pytest.raises(UnknownProviderError, match="cohere"):
        build_model(credential, _SETTINGS)


def test_openai_compatible_without_a_base_url_is_rejected() -> None:
    with pytest.raises(MissingCredentialError, match="base_url"):
        build_model(_credential("openai-compatible", base_url=None), _SETTINGS)


def test_hosted_provider_without_a_key_is_rejected() -> None:
    for provider in ("anthropic", "openai", "gemini"):
        with pytest.raises(MissingCredentialError, match="API key"):
            build_model(_credential(cast(ProviderId, provider), api_key=None), _SETTINGS)


def test_credential_repr_and_logs_never_contain_the_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    credential = _credential("openai", api_key=_KEY)
    rendered = repr(credential)
    assert _KEY not in rendered
    assert "api_key='***'" in rendered or 'api_key="***"' in rendered

    logger = logging.getLogger("brain.llm.test_redaction")
    with caplog.at_level(logging.INFO, logger=logger.name):
        logger.info("credential=%r", credential)
        try:
            raise MissingCredentialError(f"failed for {credential!r}")
        except MissingCredentialError as error:
            logger.exception("build failed: %s", error)

    combined = "\n".join(record.getMessage() for record in caplog.records)
    assert _KEY not in combined
    assert _KEY not in repr(credential)
