"""Manifest constants stay aligned with what `server/discover` reports."""

from __future__ import annotations

from mcp.client import Client

from brain.mcp.manifest import MCP_PROTOCOL_VERSION, SERVER_NAME
from brain.mcp.server import create_mcp_server


async def test_discover_reports_the_targeted_protocol_version() -> None:
    async with Client(create_mcp_server(), raise_exceptions=True) as client:
        result = await client.session.discover()

    assert MCP_PROTOCOL_VERSION in result.supported_versions
    assert result.capabilities is not None
    assert result.capabilities.tools is not None


async def test_manifest_version_matches_the_discover_response() -> None:
    async with Client(create_mcp_server(), raise_exceptions=True) as client:
        result = await client.session.discover()

    assert result.supported_versions[0] == MCP_PROTOCOL_VERSION
    server_info = (result.meta or {}).get("io.modelcontextprotocol/serverInfo")
    assert isinstance(server_info, dict)
    assert server_info.get("name") == SERVER_NAME
