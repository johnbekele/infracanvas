"""MCP server entry points for InfraCanvas.

The stdio server is a second caller of the same Python tool functions the
copilot chat panel uses, not a parallel implementation.
"""

from brain.mcp.server import BrainMcpContext, create_mcp_server

__all__ = ["BrainMcpContext", "create_mcp_server"]
