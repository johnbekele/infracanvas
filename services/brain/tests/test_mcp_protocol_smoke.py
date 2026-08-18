"""Drive `brain-mcp` over stdio the way a host does."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

from brain.mcp.manifest import MCP_PROTOCOL_VERSION, SERVER_NAME

pytestmark = pytest.mark.anyio

BRAIN_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BRAIN_DIR.parent.parent

_CLIENT_META: dict[str, Any] = {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": {"name": "infracanvas-tests", "version": "0"},
    "io.modelcontextprotocol/clientCapabilities": {},
}

DISCOVER_REQUEST: dict[str, Any] = {
    "jsonrpc": "2.0",
    "id": "discover-1",
    "method": "server/discover",
    "params": {"_meta": _CLIENT_META},
}

LIST_REQUEST: dict[str, Any] = {
    "jsonrpc": "2.0",
    "id": "list-1",
    "method": "tools/list",
    "params": {"_meta": _CLIENT_META},
}

CALL_SERVER_INFO: dict[str, Any] = {
    "jsonrpc": "2.0",
    "id": "call-1",
    "method": "tools/call",
    "params": {
        "name": "server_info",
        "arguments": {},
        "_meta": _CLIENT_META,
    },
}


async def _run_brain_mcp(
    requests: list[dict[str, Any]],
    *,
    env: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], str, float]:
    """Launch the console script and exchange newline-delimited JSON-RPC.

    Requests are written one at a time and each response is read before the next
    write. Closing stdin up-front (as `communicate` does) lets the server exit
    after the first reply and drop the rest of the batch.
    """
    proc_env = os.environ.copy()
    # Hosts often omit these; the server must still answer.
    proc_env.pop("DATABASE_URL", None)
    proc_env.pop("INFRACANVAS_TOKEN", None)
    if env is not None:
        proc_env.update(env)

    started = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        "uv",
        "run",
        "--directory",
        str(BRAIN_DIR),
        "brain-mcp",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=proc_env,
        cwd=str(REPO_ROOT),
    )
    assert proc.stdin is not None
    assert proc.stdout is not None
    assert proc.stderr is not None

    messages: list[dict[str, Any]] = []
    stderr_chunks: list[bytes] = []

    async def _drain_stderr() -> None:
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                break
            stderr_chunks.append(chunk)

    stderr_task = asyncio.create_task(_drain_stderr())
    try:
        for request in requests:
            proc.stdin.write((json.dumps(request) + "\n").encode())
            await proc.stdin.drain()
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=10)
            assert line, f"server closed stdout before answering {request.get('id')!r}"
            messages.append(json.loads(line))
        proc.stdin.close()
        await proc.wait()
    finally:
        await stderr_task

    elapsed_ms = (time.perf_counter() - started) * 1000
    assert proc.returncode == 0, b"".join(stderr_chunks).decode()
    return messages, b"".join(stderr_chunks).decode(), elapsed_ms


def _response_by_id(messages: list[dict[str, Any]], response_id: str) -> dict[str, Any]:
    for message in messages:
        if message.get("id") == response_id:
            return message
    raise AssertionError(f"no response with id={response_id!r} in {messages!r}")


@pytest.mark.integration
async def test_lists_tools_over_stdio() -> None:
    """Drive `brain-mcp` as a subprocess, exactly as a host does.

    Asserting through `mcp.Client(server)` would exercise the SDK's in-memory
    transport and prove nothing about the console script, the stdout hygiene
    rule, or the manifest a real host reads first.
    """
    messages, _stderr, elapsed_ms = await _run_brain_mcp([DISCOVER_REQUEST, LIST_REQUEST])
    assert elapsed_ms < 1500

    discover = _response_by_id(messages, "discover-1")
    result = discover["result"]
    assert MCP_PROTOCOL_VERSION in result["supportedVersions"]
    assert "tools" in result["capabilities"]
    server_info = result["_meta"]["io.modelcontextprotocol/serverInfo"]
    assert server_info["name"] == SERVER_NAME

    listed = _response_by_id(messages, "list-1")
    tools = listed["result"]["tools"]
    names = [tool["name"] for tool in tools]
    assert "server_info" in names
    server_info_tool = next(tool for tool in tools if tool["name"] == "server_info")
    input_schema = server_info_tool.get("inputSchema") or server_info_tool.get("input_schema")
    assert isinstance(input_schema, dict)
    assert input_schema.get("type") == "object"


@pytest.mark.integration
async def test_stdout_carries_only_jsonrpc_and_logging_goes_to_stderr() -> None:
    messages, stderr, _elapsed_ms = await _run_brain_mcp(
        [DISCOVER_REQUEST, LIST_REQUEST, CALL_SERVER_INFO]
    )
    for message in messages:
        assert "jsonrpc" in message
        assert message["jsonrpc"] == "2.0"
    assert "server_info called" in stderr
