"""stdio MCP server that exposes InfraCanvas tools from one registry."""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from mcp import MCPError
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError as SdkToolError
from mcp.types import INVALID_PARAMS
from mcp_types import (
    CallToolRequestParams,
    CallToolResult,
    InputRequiredResult,
    TextContent,
    ToolAnnotations,
)
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from brain import __version__
from brain.db import close_pool, open_pool, ping
from brain.mcp.errors import ToolError, ToolFailure
from brain.mcp.manifest import MCP_PROTOCOL_VERSION, SERVER_INSTRUCTIONS, SERVER_NAME
from brain.settings import Settings, load_settings

logger = logging.getLogger(__name__)

_UNEXPECTED_MESSAGE = "An unexpected error occurred"


@dataclass
class BrainMcpContext:
    """Yielded once by the lifespan and shared by every handler."""

    #: Opened when DATABASE_URL is set and reachable; otherwise None so the
    #: process can still answer discover and report database_reachable=false.
    pool: AsyncConnectionPool | None
    settings: Settings
    #: Read once from INFRACANVAS_TOKEN at startup. None means the server runs
    #: and every tool call fails `unauthenticated`, which is a far better
    #: diagnostic than a process that refuses to start inside a host that hides
    #: subprocess stderr.
    token: str | None


class ServerInfo(BaseModel):
    server_name: str
    server_version: str
    protocol_version: str
    database_reachable: bool
    authenticated: bool


def _failure_result(failure: ToolFailure) -> CallToolResult:
    payload = ToolError(code=failure.code, message=failure.message, detail=failure.detail)
    return CallToolResult(
        content=[TextContent(type="text", text=failure.message)],
        structured_content=payload.model_dump(),
        is_error=True,
    )


def _unexpected_result() -> CallToolResult:
    payload = ToolError(code="unavailable", message=_UNEXPECTED_MESSAGE)
    return CallToolResult(
        content=[TextContent(type="text", text=_UNEXPECTED_MESSAGE)],
        structured_content=payload.model_dump(),
        is_error=True,
    )


def _result_for_tool_exception(exc: BaseException) -> CallToolResult:
    """Map a tool-body exception to an `isError` result the model can read."""
    failure: ToolFailure | None = None
    if isinstance(exc, ToolFailure):
        failure = exc
    elif isinstance(exc.__cause__, ToolFailure):
        failure = exc.__cause__

    if failure is not None:
        return _failure_result(failure)

    logger.exception("Unhandled exception in MCP tool")
    return _unexpected_result()


class BrainMcpServer(MCPServer[BrainMcpContext]):
    """MCPServer that turns ToolFailure into structured tool errors.

    Unknown tools become JSON-RPC `-32602` rather than `isError` results, matching
    the protocol rule that a missing tool is a request the model cannot repair.
    """

    async def _handle_call_tool(
        self,
        ctx: Any,
        params: CallToolRequestParams,
    ) -> CallToolResult | InputRequiredResult:
        context = Context(
            request_context=ctx,
            mcp_server=self,
            input_params=params,
            subscriptions=self._subscriptions,
        )
        try:
            return await self.call_tool(params.name, params.arguments or {}, context)
        except MCPError:
            raise
        except SdkToolError as exc:
            if str(exc).startswith("Unknown tool:"):
                raise MCPError(code=INVALID_PARAMS, message=str(exc)) from exc
            return _result_for_tool_exception(exc)
        except Exception as exc:
            return _result_for_tool_exception(exc)


@asynccontextmanager
async def mcp_lifespan(_server: MCPServer[BrainMcpContext]) -> AsyncIterator[BrainMcpContext]:
    """Open shared state once; close the pool on shutdown."""
    settings = load_settings()
    token = os.environ.get("INFRACANVAS_TOKEN") or None
    pool: AsyncConnectionPool | None = None
    if settings.database_url is not None:
        try:
            pool = await open_pool(settings)
        except Exception:
            logger.warning("Database pool could not be opened at MCP startup", exc_info=True)
            pool = None

    context = BrainMcpContext(pool=pool, settings=settings, token=token)
    try:
        yield context
    finally:
        await close_pool()


def create_mcp_server() -> MCPServer[BrainMcpContext]:
    """Build the server and register every tool group.

    Deliberately a function rather than module-level state, so a test can build a
    server with a stub pool without importing a live database. Domain tools are
    not enumerated here: 030-mcp-architecture-tools.md registers by iterating
    epic 13's COPILOT_TOOLS, and this function calls its registrar.
    """
    mcp: MCPServer[BrainMcpContext] = BrainMcpServer(
        name=SERVER_NAME,
        instructions=SERVER_INSTRUCTIONS,
        version=__version__,
        lifespan=mcp_lifespan,
    )

    @mcp.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
    async def server_info(ctx: Context[BrainMcpContext]) -> ServerInfo:
        """Report version, protocol revision, and whether the database is reachable."""
        logger.info("server_info called")
        lifespan_ctx = ctx.request_context.lifespan_context
        reachable = await ping(lifespan_ctx.settings)
        return ServerInfo(
            server_name=SERVER_NAME,
            server_version=__version__,
            protocol_version=MCP_PROTOCOL_VERSION,
            database_reachable=reachable,
            authenticated=lifespan_ctx.token is not None,
        )

    return mcp
