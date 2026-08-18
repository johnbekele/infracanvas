"""Server identity and the protocol revision this package targets."""

#: The MCP revision every schema and message shape here was written against.
#: Bumping it is a reviewable change, not an implicit consequence of upgrading
#: the SDK, because the SDK supports several revisions at once.
MCP_PROTOCOL_VERSION = "2026-07-28"

SERVER_NAME = "infracanvas"

#: Returned from `server/discover` as `instructions`. Kept short: it is prepended
#: to a model's context on every session that reads it.
SERVER_INSTRUCTIONS = """\
InfraCanvas designs, prices and deploys AWS architectures for a GitHub repository.
Read an architecture before editing it. Tools that create, spend or destroy require a
confirmation token from the matching preview tool. Long operations return an operation
handle; poll get_operation rather than waiting."""
