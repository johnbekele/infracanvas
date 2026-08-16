"""Merge rules: citations, confidence, and deterministic precedence."""

from __future__ import annotations

from datetime import UTC, datetime

from brain.profile.merge import merge_profiles, sanitize_agent_findings
from brain.profile.models import (
    AgentFindings,
    AppProfileInput,
    Citation,
    Cited,
    Containerisation,
    DetectedDependency,
    LanguageBreakdown,
)


def _citation(**overrides: object) -> Citation:
    base = {
        "path": "apps/api/db.py",
        "start_line": 10,
        "end_line": 20,
        "file_sha256": "ab" * 32,
    }
    base.update(overrides)
    return Citation.model_validate(base)


def _dep(**overrides: object) -> DetectedDependency:
    base = {
        "name": "psycopg",
        "ecosystem": "pypi",
        "category": "datastore",
        "capability": "postgres",
        "source_path": "apps/api/db.py",
    }
    base.update(overrides)
    return DetectedDependency.model_validate(base)


def _deterministic(**overrides: object) -> AppProfileInput:
    base: dict[str, object] = {
        "schema_version": 1,
        "commit_sha": "a" * 40,
        "ref": "main",
        "analysed_at": datetime(2026, 8, 10, tzinfo=UTC),
        "languages": [LanguageBreakdown(name="Python", bytes=100, share=1.0)],
        "components": [],
        "dependencies": [],
        "containerisation": Containerisation(dockerfiles=[], compose_files=[], exposed_ports=[]),
        "file_count": 1,
        "total_bytes": 100,
        "notes": [],
    }
    base.update(overrides)
    return AppProfileInput.model_validate(base)


def _cited_dep(
    dependency: DetectedDependency,
    *,
    confidence: float = 0.8,
    citations: list[Citation] | None = None,
) -> Cited[DetectedDependency]:
    return Cited(
        value=dependency,
        confidence=confidence,
        citations=citations or [_citation()],
        source="agent",
    )


def test_discards_a_finding_citing_a_span_no_tool_returned() -> None:
    findings = AgentFindings(dependencies=[_cited_dep(_dep())])
    kept, rejected, notes = sanitize_agent_findings(findings, reads=[])

    assert kept.dependencies == []
    assert len(rejected) == 1
    assert "citation was never returned by a tool" in rejected[0].reason
    assert any("Discarded" in note for note in notes)


def test_records_a_low_confidence_finding_as_a_note() -> None:
    citation = _citation()
    findings = AgentFindings(
        dependencies=[_cited_dep(_dep(), confidence=0.4, citations=[citation])]
    )
    kept, rejected, notes = sanitize_agent_findings(findings, reads=[citation])

    assert kept.dependencies == []
    assert rejected[0].reason.startswith("confidence 0.4")
    assert any("Low-confidence" in note for note in notes)


def test_clamps_agent_confidence_to_the_ceiling() -> None:
    citation = _citation()
    findings = AgentFindings(
        dependencies=[_cited_dep(_dep(), confidence=0.99, citations=[citation])]
    )
    kept, _rejected, notes = sanitize_agent_findings(findings, reads=[citation])

    assert len(kept.dependencies) == 1
    assert kept.dependencies[0].confidence == 0.9
    assert any("Clamped confidence" in note for note in notes)


def test_deterministic_finding_wins_over_a_conflicting_agent_finding() -> None:
    citation = _citation()
    deterministic_dep = _dep(
        name="pg",
        capability="postgres",
        source_path="apps/api/package.json",
        ecosystem="npm",
        category="datastore",
    )
    agent_dep = _dep(
        name="pg",
        capability="mysql",
        source_path="apps/api/db.py",
        ecosystem="npm",
        category="datastore",
    )
    profile = merge_profiles(
        _deterministic(dependencies=[deterministic_dep]),
        AgentFindings(dependencies=[_cited_dep(agent_dep, citations=[citation])]),
    )

    assert len(profile.dependencies) == 1
    assert profile.dependencies[0].source == "deterministic"
    assert profile.dependencies[0].value.capability == "postgres"
    assert any("Kept deterministic" in note for note in profile.notes)


def test_agent_cannot_attach_a_capability_to_an_orm() -> None:
    citation = _citation()
    orm = _dep(
        name="sqlalchemy",
        category="orm",
        capability=None,
        source_path="apps/api/pyproject.toml",
    )
    agent_attempt = _dep(
        name="sqlalchemy",
        category="orm",
        capability="postgres",
        source_path="apps/api/models.py",
    )
    # Same name as the ORM but treated as a new key only if ecosystem differs —
    # use a different ecosystem so it is not a conflict win, then assert ORM
    # capability clearing on sanitize when orm_keys is provided.
    kept, _rejected, notes = sanitize_agent_findings(
        AgentFindings(dependencies=[_cited_dep(agent_attempt, citations=[citation])]),
        reads=[citation],
        orm_keys={("sqlalchemy", "pypi")},
    )

    assert kept.dependencies[0].value.capability is None
    assert any("Cleared capability on ORM" in note for note in notes)

    # Also via merge when the deterministic ORM is present and the agent uses
    # a distinct source path but the same name/ecosystem (conflict path):
    profile = merge_profiles(
        _deterministic(dependencies=[orm]),
        AgentFindings(dependencies=[_cited_dep(agent_attempt, citations=[citation])]),
    )
    assert profile.dependencies[0].value.capability is None
    assert profile.dependencies[0].source == "deterministic"
