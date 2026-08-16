"""Construct pydantic-ai models from stored provider credentials."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, cast

from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.bedrock import BedrockConverseModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.bedrock import BedrockProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.providers.openai import OpenAIProvider

from brain.settings import Settings

ProviderId = Literal[
    "anthropic",
    "bedrock",
    "openai",
    "gemini",
    "ollama",
    "openai-compatible",
]


@dataclass(frozen=True, slots=True)
class ProviderCredential:
    provider: ProviderId
    model: str
    # None for ollama and bedrock; required for every other provider.
    api_key: str | None
    # Required for openai-compatible; optional elsewhere.
    base_url: str | None

    def __repr__(self) -> str:
        """Redacts the key. A credential ends up in tracebacks and log records,
        and neither is a place a user's API key may appear."""
        redacted = "***" if self.api_key is not None else None
        return (
            f"ProviderCredential(provider={self.provider!r}, model={self.model!r}, "
            f"api_key={redacted!r}, base_url={self.base_url!r})"
        )


class UnknownProviderError(ValueError):
    """The stored provider string is not one this build knows."""


class MissingCredentialError(RuntimeError):
    """The provider needs a field the stored row does not have."""


class _LazyClient:
    """Construct the vendor SDK client on first attribute access.

    pydantic-ai provider classes build their HTTP clients eagerly. That is fine
    for an agent that is about to call the model, but build_model must stay under
    5ms and open no socket, so the real client is deferred until a request.
    """

    __slots__ = ("_client", "_factory")

    def __init__(self, factory: Callable[[], Any]) -> None:
        self._factory = factory
        self._client: Any | None = None

    def _get(self) -> Any:
        if self._client is None:
            self._client = self._factory()
        return self._client

    def __getattr__(self, name: str) -> Any:
        return getattr(self._get(), name)


def _require_api_key(credential: ProviderCredential) -> str:
    if not credential.api_key:
        raise MissingCredentialError(f"Provider {credential.provider!r} requires an API key")
    return credential.api_key


def _build_anthropic(credential: ProviderCredential, settings: Settings) -> Model:
    del settings
    api_key = _require_api_key(credential)
    base_url = credential.base_url

    def factory() -> Any:
        from anthropic import AsyncAnthropic

        return AsyncAnthropic(api_key=api_key, base_url=base_url)

    return AnthropicModel(
        credential.model,
        provider=AnthropicProvider(anthropic_client=cast(Any, _LazyClient(factory))),
    )


def _build_bedrock(credential: ProviderCredential, settings: Settings) -> Model:
    del settings

    def factory() -> Any:
        import boto3  # type: ignore[import-untyped]

        # Ambient AWS credentials are resolved here, on first use.
        return boto3.client("bedrock-runtime")

    return BedrockConverseModel(
        credential.model,
        provider=BedrockProvider(bedrock_client=cast(Any, _LazyClient(factory))),
    )


def _openai_client_factory(api_key: str, base_url: str | None) -> Callable[[], Any]:
    def factory() -> Any:
        from openai import AsyncOpenAI

        return AsyncOpenAI(api_key=api_key, base_url=base_url)

    return factory


def _build_openai(credential: ProviderCredential, settings: Settings) -> Model:
    del settings
    api_key = _require_api_key(credential)
    return OpenAIChatModel(
        credential.model,
        provider=OpenAIProvider(
            openai_client=cast(
                Any, _LazyClient(_openai_client_factory(api_key, credential.base_url))
            )
        ),
    )


def _build_gemini(credential: ProviderCredential, settings: Settings) -> Model:
    del settings
    api_key = _require_api_key(credential)
    base_url = credential.base_url

    def factory() -> Any:
        from google.genai import Client
        from google.genai.types import HttpOptions

        http_options = HttpOptions(base_url=base_url) if base_url else None
        return Client(vertexai=False, api_key=api_key, http_options=http_options)

    return GoogleModel(
        credential.model,
        provider=GoogleProvider(client=cast(Any, _LazyClient(factory))),
    )


def _build_ollama(credential: ProviderCredential, settings: Settings) -> Model:
    base_url = credential.base_url or settings.ollama_base_url
    # OpenAI's client requires a non-empty key even when the server ignores it.
    api_key = credential.api_key or "api-key-not-set"

    return OllamaModel(
        credential.model,
        provider=OllamaProvider(
            openai_client=cast(Any, _LazyClient(_openai_client_factory(api_key, base_url)))
        ),
    )


def _build_openai_compatible(credential: ProviderCredential, settings: Settings) -> Model:
    del settings
    if not credential.base_url:
        raise MissingCredentialError("Provider 'openai-compatible' requires a base_url")
    api_key = _require_api_key(credential)
    return OpenAIChatModel(
        credential.model,
        provider=OpenAIProvider(
            openai_client=cast(
                Any, _LazyClient(_openai_client_factory(api_key, credential.base_url))
            )
        ),
    )


_BUILDERS: dict[ProviderId, Callable[[ProviderCredential, Settings], Model]] = {
    "anthropic": _build_anthropic,
    "bedrock": _build_bedrock,
    "openai": _build_openai,
    "gemini": _build_gemini,
    "ollama": _build_ollama,
    "openai-compatible": _build_openai_compatible,
}


def build_model(credential: ProviderCredential, settings: Settings) -> Model:
    """Construct a pydantic-ai model. Opens no socket and makes no request."""
    builder = _BUILDERS.get(credential.provider)
    if builder is None:
        raise UnknownProviderError(f"Unknown provider {credential.provider!r}")
    return builder(credential, settings)
