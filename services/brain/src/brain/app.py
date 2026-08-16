"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from brain import __version__
from brain.db import close_pool
from brain.health import router as health_router
from brain.routes.profile import router as profile_router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Release the connection pool on shutdown.

    Nothing is opened on startup: the pool is created on first use so that the
    service starts, and can report why it is unhealthy, even when the database
    is unreachable.
    """
    yield
    await close_pool()


def create_app() -> FastAPI:
    app = FastAPI(
        title="InfraCanvas Brain",
        version=__version__,
        lifespan=lifespan,
    )
    app.include_router(health_router)
    app.include_router(profile_router)
    return app
