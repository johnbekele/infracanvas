"""Agent repair loop: one correction attempt, then give up."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from brain.profile.agent import ReasoningSettings, build_profile
from brain.profile.models import (
    AgentFindings,
    AppProfileInput,
    Citation,
    Cited,
    Containerisation,
    DetectedDependency,
    LanguageBreakdown,
)
from brain.profile.tools import ProfileDeps


def _deterministic() -> AppProfileInput:
    return AppProfileInput(
        schema_version=1,
        commit_sha="a" * 40,
        ref="main",
        analysed_at=datetime(2026, 8, 10, tzinfo=UTC),
        languages=[LanguageBreakdown(name="Python", bytes=100, share=1.0)],
        components=[],
        dependencies=[],
        containerisation=Containerisation(dockerfiles=[], compose_files=[], exposed_ports=[]),
        file_count=1,
        total_bytes=100,
        notes=[],
    )


def _unsupported_findings() -> AgentFindings:
    return AgentFindings(
        dependencies=[
            Cited(
                value=DetectedDependency(
                    name="psycopg",
                    ecosystem="pypi",
                    category="datastore",
                    capability="postgres",
                    source_path="apps/api/db.py",
                ),
                confidence=0.8,
                citations=[
                    Citation(
                        path="apps/api/db.py",
                        start_line=1,
                        end_line=5,
                        file_sha256="ab" * 32,
                    )
                ],
                source="agent",
            )
        ]
    )


async def test_repairs_once_then_gives_up() -> None:
    calls = {"count": 0}

    async def reply(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        calls["count"] += 1
        payload = _unsupported_findings().model_dump_json()
        return ModelResponse(parts=[TextPart(content=payload)])

    deps = ProfileDeps(
        repository_id=uuid4(),
        run_id=uuid4(),
        pool=None,  # type: ignore[arg-type]
    )

    profile = await build_profile(
        _deterministic(),
        deps,
        FunctionModel(reply),
        ReasoningSettings(max_tokens=512),
    )

    assert calls["count"] == 2
    assert profile.dependencies == []
    assert any("citation was never returned" in note for note in profile.notes)
    assert any("Gave up" in note for note in profile.notes)
