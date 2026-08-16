"""Model provider registry: decrypt credentials and build pydantic-ai models."""

from brain.llm.credentials import load_default_credential
from brain.llm.crypto import decrypt
from brain.llm.providers import (
    MissingCredentialError,
    ProviderCredential,
    ProviderId,
    UnknownProviderError,
    build_model,
)

__all__ = [
    "MissingCredentialError",
    "ProviderCredential",
    "ProviderId",
    "UnknownProviderError",
    "build_model",
    "decrypt",
    "load_default_credential",
]
