"""Process configuration, read once at import time."""

from __future__ import annotations

import os
from dataclasses import dataclass

_DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1"


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str | None
    environment: str
    # 64 hex characters, the same value apps/api reads as ENCRYPTION_KEY.
    encryption_key: str | None = None
    # Default "http://localhost:11434/v1"; the offline path depends on it.
    ollama_base_url: str = _DEFAULT_OLLAMA_BASE_URL

    @property
    def has_database(self) -> bool:
        return bool(self.database_url)


def load_settings() -> Settings:
    """Read configuration from the environment.

    A missing DATABASE_URL is not fatal. The service must still start so that
    its health endpoint can report *why* it is unhealthy; a process that exits
    on boot tells an operator nothing beyond "it is gone".
    """
    return Settings(
        database_url=os.environ.get("DATABASE_URL") or None,
        environment=os.environ.get("ENVIRONMENT", "development"),
        encryption_key=os.environ.get("ENCRYPTION_KEY") or None,
        ollama_base_url=os.environ.get("OLLAMA_BASE_URL") or _DEFAULT_OLLAMA_BASE_URL,
    )
