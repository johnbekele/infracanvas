"""`server_info` reports configuration without refusing to start."""

from __future__ import annotations

import pytest
from mcp.client import Client

from brain.mcp.manifest import MCP_PROTOCOL_VERSION, SERVER_NAME
from brain.mcp.server import create_mcp_server

pytestmark = pytest.mark.anyio


async def test_tool_order_is_stable_across_calls(client: Client) -> None:
    first = await client.list_tools()
    second = await client.list_tools()
    assert [tool.name for tool in first.tools] == [tool.name for tool in second.tools]


async def test_starts_without_a_database_url_and_reports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("INFRACANVAS_TOKEN", raising=False)

    async with Client(create_mcp_server(), raise_exceptions=True) as client:
        result = await client.call_tool("server_info", {})

    assert result.is_error is False
    assert result.structured_content is not None
    assert result.structured_content["database_reachable"] is False
    assert result.structured_content["server_name"] == SERVER_NAME
    assert result.structured_content["protocol_version"] == MCP_PROTOCOL_VERSION


async def test_starts_without_a_token_and_reports_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INFRACANVAS_TOKEN", raising=False)

    async with Client(create_mcp_server(), raise_exceptions=True) as client:
        listed = await client.list_tools()
        assert any(tool.name == "server_info" for tool in listed.tools)
        result = await client.call_tool("server_info", {})

    assert result.is_error is False
    assert result.structured_content is not None
    assert result.structured_content["authenticated"] is False
