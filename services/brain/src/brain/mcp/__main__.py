"""stdio entry point for the `brain-mcp` console script."""

from __future__ import annotations

import logging
import sys

from brain.mcp.server import create_mcp_server


def main() -> int:
    """stdio entry point for the `brain-mcp` console script."""
    # stdout is the JSON-RPC wire; every log line must stay on stderr.
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(levelname)s %(name)s: %(message)s",
        force=True,
    )
    server = create_mcp_server()
    server.run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
