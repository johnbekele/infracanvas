"""Postgres access for the brain service.

The pool is opened lazily rather than at import so that the module can be
imported in a test process, or on a machine with no database, without a
connection attempt as a side effect.
"""

from __future__ import annotations

import logging

from psycopg_pool import AsyncConnectionPool

from brain.settings import Settings

logger = logging.getLogger(__name__)

# Bounds how long /health can block. A probe that waits ten seconds to report a
# dead database has already failed the load balancer's own timeout, so the
# answer arrives too late to be acted on.
CONNECT_TIMEOUT_SECONDS = 3.0

_pool: AsyncConnectionPool | None = None


class DatabaseNotConfiguredError(RuntimeError):
    """Raised when database access is attempted with no DATABASE_URL set."""


async def open_pool(settings: Settings) -> AsyncConnectionPool:
    """Return the process-wide pool, opening it on first use."""
    global _pool

    if _pool is not None:
        return _pool

    if settings.database_url is None:
        raise DatabaseNotConfiguredError("DATABASE_URL is not set")

    # Constructing with `open=False` and opening explicitly keeps construction
    # separate from connection, so an unreachable database raises here rather
    # than somewhere inside the first request that happens to touch it.
    pool = AsyncConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=5,
        timeout=CONNECT_TIMEOUT_SECONDS,
        open=False,
    )
    await pool.open(wait=True, timeout=CONNECT_TIMEOUT_SECONDS)
    _pool = pool
    return pool


async def close_pool() -> None:
    """Close the pool if one was opened. Safe to call when none was."""
    global _pool

    if _pool is not None:
        await _pool.close()
        _pool = None


async def ping(settings: Settings) -> bool:
    """Report whether the database can currently serve a trivial query.

    Every failure mode collapses to False on purpose. An unreachable host, an
    exhausted pool, and a rejected password all mean "this process cannot do
    its job", and the caller needs only that one bit to decide whether to send
    it traffic. The reason is logged for the human who has to fix it.
    """
    try:
        pool = await open_pool(settings)
        async with pool.connection() as conn:
            await conn.execute("SELECT 1")
    except Exception as error:
        logger.warning("Database ping failed: %s", error)
        return False
    return True
