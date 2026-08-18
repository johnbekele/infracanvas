"""ToolFailure and unexpected exceptions become safe `isError` results."""

from __future__ import annotations

import pytest
from mcp import MCPError
from mcp.client import Client
from mcp.types import INVALID_PARAMS
from mcp_types import TextContent

from brain.mcp.errors import ToolError, ToolFailure
from brain.mcp.server import create_mcp_server


async def test_unknown_tool_is_a_protocol_error_not_a_tool_error() -> None:
    async with Client(create_mcp_server(), raise_exceptions=True) as client:
        with pytest.raises(MCPError) as raised:
            await client.call_tool("definitely_not_registered", {})

    assert raised.value.code == INVALID_PARAMS
    assert raised.value.code == -32602


async def test_tool_failure_becomes_an_is_error_result_with_a_structured_code() -> None:
    server = create_mcp_server()
    message = "architecture not found for this user"

    @server.tool()
    async def boom() -> str:
        raise ToolFailure("not_found", message, architecture_id="arch-1")

    async with Client(server, raise_exceptions=True) as client:
        result = await client.call_tool("boom", {})

    assert result.is_error is True
    assert result.structured_content is not None
    error = ToolError.model_validate(result.structured_content)
    assert error.code == "not_found"
    assert error.message == message
    assert error.detail == {"architecture_id": "arch-1"}

    texts = [block.text for block in result.content if isinstance(block, TextContent)]
    assert message in texts
    assert error.message in texts


async def test_unexpected_exception_is_not_leaked_to_the_caller() -> None:
    server = create_mcp_server()
    # Deliberately includes a path, SQL, and a connection string so the assertion
    # proves those shapes are stripped from the caller-visible message.
    leaked = (
        "SELECT * FROM users WHERE id=1 at /var/lib/postgresql/data "
        "connection=postgres://ic:not-a-real-secret@localhost:5432/infracanvas"
    )

    @server.tool()
    async def crash() -> str:
        raise RuntimeError(leaked)

    async with Client(server, raise_exceptions=True) as client:
        result = await client.call_tool("crash", {})

    assert result.is_error is True
    assert result.structured_content is not None
    error = ToolError.model_validate(result.structured_content)
    assert error.code == "unavailable"
    blob = " ".join(
        [error.message, *(block.text for block in result.content if isinstance(block, TextContent))]
    )
    assert "/var/lib/postgresql" not in blob
    assert "SELECT" not in blob
    assert "postgres://" not in blob
    assert "not-a-real-secret" not in blob
