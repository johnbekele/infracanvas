"""Process configuration, read once at import time."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Settings:
    database_url: str | None
    environment: str

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
    )
