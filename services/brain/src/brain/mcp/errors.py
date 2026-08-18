"""Recoverable tool failures surfaced as `isError` results, not JSON-RPC errors."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ToolErrorCode = Literal[
    "unauthenticated",  # no token, unknown token, revoked or expired
    "insufficient_scope",  # token is valid but lacks the scope this tool needs
    "not_found",  # the object does not exist, or is not this user's
    "invalid_argument",  # validated shape, unusable value
    "conflict",  # the object is in a state that forbids this call
    "confirmation_required",  # a destructive tool called with no confirmation token
    "confirmation_invalid",  # expired, already used, or bound to a different plan
    "rate_limited",
    "unavailable",  # the database, the API or AWS could not be reached
]


class ToolFailure(Exception):  # noqa: N818 — contract name; not an Error suffix on purpose
    """A failure the calling model can act on.

    Raised by tool bodies and turned into a tool result with `isError: true`
    rather than a JSON-RPC error, because the protocol reserves JSON-RPC errors
    for malformed requests and unknown tools - things a model cannot fix - and
    directs recoverable failures into the result so the model can read and
    retry them.
    """

    def __init__(self, code: ToolErrorCode, message: str, **detail: object) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail: dict[str, object] = dict(detail)


class ToolError(BaseModel):
    """The `structuredContent` of a failed tool result."""

    code: ToolErrorCode
    message: str
    detail: dict[str, object] = Field(default_factory=dict)
