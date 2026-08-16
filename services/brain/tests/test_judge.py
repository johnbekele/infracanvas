"""Judge: fresh call, fast scale, claim and span only."""

from __future__ import annotations

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from brain.profile.judge import FAST_MAX_TOKENS, Judge, JudgeBatchResult


async def test_judge_receives_no_repository_access() -> None:
    seen: dict[str, object] = {}

    async def reply(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen["messages"] = messages
        seen["info"] = info
        seen["message_count"] = len(messages)
        payload = JudgeBatchResult(supported=[True, False]).model_dump_json()
        return ModelResponse(parts=[TextPart(content=payload)])

    judge = Judge(FunctionModel(reply))

    assert judge.repository_tools == ()
    assert judge.reasoning_scale == "fast"
    assert judge.model_settings.get("max_tokens") == FAST_MAX_TOKENS

    answers = await judge.supports(
        [
            ("depends on psycopg", "import psycopg\n"),
            ("is a background worker", "def handle_request():\n    pass\n"),
        ]
    )

    assert answers == [True, False]
    assert seen["message_count"] == 1
    # FunctionModel still receives the user prompt as messages; there must be
    # no prior conversation and no tool definitions for the judge to call.
    assert info_tools_empty(seen["info"])
    prompt = user_prompt_text(seen["messages"])
    assert "depends on psycopg" in prompt
    assert "import psycopg" in prompt
    assert "background worker" in prompt
    assert "list_files" not in prompt
    assert "read_span" not in prompt
    assert "search_text" not in prompt


def info_tools_empty(info: object) -> bool:
    function_tools = getattr(info, "function_tools", None)
    if function_tools is not None:
        return len(function_tools) == 0
    tools = getattr(info, "tools", None)
    if tools is not None:
        return len(tools) == 0
    return True


def user_prompt_text(messages: object) -> str:
    parts: list[str] = []
    if not isinstance(messages, list):
        return ""
    for message in messages:
        for part in getattr(message, "parts", []):
            content = getattr(part, "content", None)
            if isinstance(content, str):
                parts.append(content)
    return "\n".join(parts)
