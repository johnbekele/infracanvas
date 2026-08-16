"""Citation verifier: literal checks, span integrity, and judge budget."""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

import pytest

from brain.profile.merge import (
    wrap_deterministic_component,
    wrap_deterministic_containerisation,
    wrap_deterministic_dependency,
)
from brain.profile.models import (
    Citation,
    Cited,
    CitedAppProfile,
    Component,
    Containerisation,
    DetectedDependency,
    LanguageBreakdown,
    Verification,
    VerifiedAppProfile,
    VerifiedCited,
)
from brain.profile.verifier import (
    LITERAL_TERMS,
    MAX_CLAIMS_PER_JUDGE_CALL,
    MAX_JUDGE_CALLS,
    SpanSnapshot,
    UnsupportedClaimError,
    literal_terms_supported,
    term_appears_in_span,
    verify_citation,
    verify_profile,
)

FIXTURE = Path(__file__).parent / "fixtures" / "profile" / "expected_profile.json"


class FakeSpanReader:
    """In-memory span reader keyed by (path, start, end)."""

    def __init__(self, spans: dict[tuple[str, int, int], SpanSnapshot | None]) -> None:
        self._spans = spans
        self.requests: list[tuple[str, int, int]] = []

    async def read(self, path: str, start_line: int, end_line: int) -> SpanSnapshot | None:
        self.requests.append((path, start_line, end_line))
        return self._spans.get((path, start_line, end_line))


class RecordingJudge:
    """Test double that records batches and never touches a repository."""

    repository_tools: tuple[()] = ()

    def __init__(self, answers: list[bool] | None = None) -> None:
        self.calls: list[list[tuple[str, str]]] = []
        self._answers = answers

    async def supports(self, claims: Sequence[tuple[str, str]]) -> list[bool]:
        self.calls.append(list(claims))
        if self._answers is not None:
            return list(self._answers[: len(claims)])
        return [True] * len(claims)


def _citation(**overrides: object) -> Citation:
    base: dict[str, object] = {
        "path": "apps/api/pyproject.toml",
        "start_line": 1,
        "end_line": 5,
        "file_sha256": "ab" * 32,
    }
    base.update(overrides)
    return Citation.model_validate(base)


def _dependency(**overrides: object) -> DetectedDependency:
    base: dict[str, object] = {
        "name": "psycopg",
        "ecosystem": "pypi",
        "category": "datastore",
        "capability": "postgres",
        "source_path": "apps/api/pyproject.toml",
    }
    base.update(overrides)
    return DetectedDependency.model_validate(base)


def _component(**overrides: object) -> Component:
    base: dict[str, object] = {
        "path": "apps/api",
        "name": "api",
        "kind": "api",
        "ecosystems": ["pypi"],
        "manifest_paths": ["apps/api/pyproject.toml"],
        "dependency_count": 1,
        "capabilities": ["http-server"],
        "dependencies": [],
        "dockerfiles": ["apps/api/Dockerfile"],
        "exposed_ports": [8000],
        "compose_service": "api",
        "deployable": True,
    }
    base.update(overrides)
    return Component.model_validate(base)


def _containerisation(**overrides: object) -> Containerisation:
    base: dict[str, object] = {
        "dockerfiles": ["apps/api/Dockerfile"],
        "compose_files": ["docker-compose.yml"],
        "exposed_ports": [8000],
    }
    base.update(overrides)
    return Containerisation.model_validate(base)


def _profile(
    *,
    dependencies: list[Cited[DetectedDependency]] | None = None,
    components: list[Cited[Component]] | None = None,
    containerisation: Cited[Containerisation] | None = None,
) -> CitedAppProfile:
    container = containerisation or Cited(
        value=_containerisation(),
        confidence=1.0,
        citations=[_citation(path="apps/api/Dockerfile", start_line=1, end_line=3)],
        source="deterministic",
    )
    return CitedAppProfile(
        schema_version=1,
        commit_sha="a" * 40,
        ref="main",
        analysed_at=datetime(2026, 8, 10, tzinfo=UTC),
        languages=[LanguageBreakdown(name="Python", bytes=100, share=1.0)],
        components=components or [],
        dependencies=dependencies or [],
        containerisation=container,
        file_count=1,
        total_bytes=100,
        notes=[],
    )


def _dockerfile_span(*, sha: str = "ab" * 32) -> SpanSnapshot:
    return SpanSnapshot(text='FROM python:3.12\nEXPOSE 8000\nCMD ["api"]\n', file_sha256=sha)


async def test_drops_a_dependency_absent_from_its_own_span() -> None:
    citation = _citation()
    dep = Cited(
        value=_dependency(name="psycopg"),
        confidence=0.8,
        citations=[citation],
        source="agent",
    )
    reader = FakeSpanReader(
        {
            (citation.path, citation.start_line, citation.end_line): SpanSnapshot(
                text='dependencies = ["fastapi"]\n',
                file_sha256=citation.file_sha256,
            ),
            ("apps/api/Dockerfile", 1, 3): _dockerfile_span(),
        }
    )
    judge = RecordingJudge()

    verified = await verify_profile(_profile(dependencies=[dep]), reader, judge)

    assert verified.dependencies == []
    assert any("psycopg" in note and "Dropped dependency" in note for note in verified.notes)
    assert judge.calls == []


async def test_reports_span_changed_when_the_file_hash_differs() -> None:
    citation = _citation(file_sha256="ab" * 32)
    reader = FakeSpanReader(
        {
            (citation.path, citation.start_line, citation.end_line): SpanSnapshot(
                text="psycopg==3.0\n",
                file_sha256="cd" * 32,
            )
        }
    )

    result = await verify_citation("psycopg", citation, reader)

    assert result.verdict == "span_changed"
    assert result.checked_by == "literal"
    assert "changed" in result.reason.lower()


async def test_reports_span_missing_when_the_range_no_longer_exists() -> None:
    citation = _citation()
    reader = FakeSpanReader({(citation.path, citation.start_line, citation.end_line): None})
    judge = RecordingJudge(answers=[True])

    result = await verify_citation("psycopg", citation, reader)

    assert result.verdict == "span_missing"
    assert judge.calls == []

    dep = Cited(
        value=_dependency(),
        confidence=0.8,
        citations=[citation],
        source="agent",
    )
    profile_reader = FakeSpanReader(
        {
            (citation.path, citation.start_line, citation.end_line): None,
            ("apps/api/Dockerfile", 1, 3): _dockerfile_span(),
        }
    )
    verified = await verify_profile(_profile(dependencies=[dep]), profile_reader, judge)
    assert verified.dependencies == []
    assert any("no longer available" in note for note in verified.notes)
    assert judge.calls == []


async def test_literal_match_never_calls_the_judge() -> None:
    citation = _citation()
    dep = Cited(
        value=_dependency(name="psycopg"),
        confidence=0.8,
        citations=[citation],
        source="agent",
    )
    reader = FakeSpanReader(
        {
            (citation.path, citation.start_line, citation.end_line): SpanSnapshot(
                text='dependencies = ["psycopg"]\n',
                file_sha256=citation.file_sha256,
            ),
            ("apps/api/Dockerfile", 1, 3): _dockerfile_span(),
        }
    )
    judge = RecordingJudge(answers=[False])

    verified = await verify_profile(_profile(dependencies=[dep]), reader, judge)

    assert len(verified.dependencies) == 1
    assert verified.dependencies[0].verification.checked_by == "literal"
    assert verified.dependencies[0].verification.verdict == "supported"
    assert judge.calls == []


async def test_literal_match_is_not_satisfied_by_a_near_miss() -> None:
    assert not term_appears_in_span("aws-sdk", "import aws sdk from somewhere")
    assert not literal_terms_supported(["aws-sdk"], "import aws sdk from somewhere")
    assert term_appears_in_span("aws-sdk", 'dependencies = ["aws-sdk"]')

    extractor = LITERAL_TERMS["dependency.name"]
    terms = extractor(_dependency(name="aws-sdk"))
    assert terms == ["aws-sdk"]
    assert not literal_terms_supported(terms, "# uses the aws sdk helpers")


async def test_judge_receives_no_repository_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delitem(LITERAL_TERMS, "dependency.name")

    citation = _citation()
    dep = Cited(
        value=_dependency(name="obscure-lib"),
        confidence=0.8,
        citations=[citation],
        source="agent",
    )
    reader = FakeSpanReader(
        {
            (citation.path, citation.start_line, citation.end_line): SpanSnapshot(
                text="from obscure_lib import Client  # background worker setup\n",
                file_sha256=citation.file_sha256,
            ),
            ("apps/api/Dockerfile", 1, 3): _dockerfile_span(),
        }
    )
    judge = RecordingJudge(answers=[True])

    verified = await verify_profile(_profile(dependencies=[dep]), reader, judge)

    assert judge.repository_tools == ()
    assert len(judge.calls) == 1
    batch = judge.calls[0]
    assert len(batch) == 1
    claim, span = batch[0]
    assert "obscure-lib" in claim
    assert "obscure_lib" in span
    assert "repository" not in claim.lower()
    assert verified.dependencies[0].verification.checked_by == "model"


async def test_unjudged_claims_are_treated_as_unsupported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delitem(LITERAL_TERMS, "dependency.name")

    total = MAX_JUDGE_CALLS * MAX_CLAIMS_PER_JUDGE_CALL + 3
    deps: list[Cited[DetectedDependency]] = []
    spans: dict[tuple[str, int, int], SpanSnapshot | None] = {
        ("apps/api/Dockerfile", 1, 3): _dockerfile_span(),
    }
    for index in range(total):
        citation = _citation(path=f"apps/api/mod_{index}.py", start_line=1, end_line=2)
        deps.append(
            Cited(
                value=_dependency(name=f"lib-{index}", source_path=citation.path),
                confidence=0.8,
                citations=[citation],
                source="agent",
            )
        )
        spans[(citation.path, 1, 2)] = SpanSnapshot(
            text=f"import lib_{index}\n",
            file_sha256=citation.file_sha256,
        )

    judge = RecordingJudge()
    verified = await verify_profile(_profile(dependencies=deps), FakeSpanReader(spans), judge)

    assert len(judge.calls) == MAX_JUDGE_CALLS
    assert len(verified.dependencies) == MAX_JUDGE_CALLS * MAX_CLAIMS_PER_JUDGE_CALL
    dropped = [note for note in verified.notes if "budget was exhausted" in note]
    assert len(dropped) == 3


async def test_missing_containerisation_citation_raises_rather_than_omitting() -> None:
    reader = FakeSpanReader({("apps/api/Dockerfile", 1, 3): None})
    judge = RecordingJudge()

    with pytest.raises(UnsupportedClaimError, match="containerisation"):
        await verify_profile(_profile(), reader, judge)


async def test_verifies_deterministic_findings_on_the_same_path() -> None:
    dependency = _dependency(name="fastapi")
    component = _component()
    containerisation = _containerisation(exposed_ports=[8000])

    dep_cited = wrap_deterministic_dependency(dependency)
    comp_cited = wrap_deterministic_component(component)
    cont_cited = wrap_deterministic_containerisation(containerisation)

    # Same verification path as agent findings: real span text and matching hash.
    # Dependency and component both cite pyproject.toml line 1 in the merge
    # helpers, so one span must satisfy both literal checks.
    shared_manifest = SpanSnapshot(
        text='[project]\nname = "api"\ndependencies = ["fastapi"]\n# pyproject.toml\n',
        file_sha256=dep_cited.citations[0].file_sha256,
    )
    reader = FakeSpanReader(
        {
            (
                dep_cited.citations[0].path,
                dep_cited.citations[0].start_line,
                dep_cited.citations[0].end_line,
            ): shared_manifest,
            (
                cont_cited.citations[0].path,
                cont_cited.citations[0].start_line,
                cont_cited.citations[0].end_line,
            ): SpanSnapshot(
                text="FROM python:3.12\nEXPOSE 8000\n",
                file_sha256=cont_cited.citations[0].file_sha256,
            ),
        }
    )
    judge = RecordingJudge(answers=[False])

    verified = await verify_profile(
        _profile(
            dependencies=[dep_cited],
            components=[comp_cited],
            containerisation=cont_cited,
        ),
        reader,
        judge,
    )

    assert len(verified.dependencies) == 1
    assert verified.dependencies[0].source == "deterministic"
    assert verified.dependencies[0].verification.verdict == "supported"
    assert verified.dependencies[0].verification.checked_by == "literal"
    assert verified.components[0].source == "deterministic"
    assert verified.components[0].verification.verdict == "supported"
    assert verified.containerisation.verification.verdict == "supported"
    assert judge.calls == []
    assert verified.dependencies[0].verification.verdict == "supported"
    assert verified.components[0].verification.verdict == "supported"
    assert verified.containerisation.verification.verdict == "supported"


def test_verified_fixture_profile_strips_to_expected_app_profile() -> None:
    """Document the verification results the fixture profile is expected to carry.

    The JSON fixture stays the stripped AppProfile wire shape (so
    test_profile_models keeps working). Verification envelopes live on
    VerifiedAppProfile and strip away via to_app_profile().
    """
    expected = json.loads(FIXTURE.read_text())
    dependency = DetectedDependency(
        name="fastapi",
        ecosystem="pypi",
        category="web-framework",
        capability="http-server",
        source_path="apps/api/pyproject.toml",
    )
    component = Component(
        path="apps/api",
        name="api",
        kind="api",
        ecosystems=["pypi"],
        manifest_paths=["apps/api/pyproject.toml"],
        dependency_count=1,
        capabilities=["http-server"],
        dependencies=[dependency],
        dockerfiles=["apps/api/Dockerfile"],
        exposed_ports=[8000],
        compose_service="api",
        deployable=True,
    )
    containerisation = Containerisation(
        dockerfiles=["apps/api/Dockerfile"],
        compose_files=["docker-compose.yml"],
        exposed_ports=[8000],
    )
    supported = Verification(
        verdict="supported",
        checked_by="literal",
        reason="The cited span contains every required term.",
    )
    dep_cited = wrap_deterministic_dependency(dependency)
    comp_cited = wrap_deterministic_component(component)
    cont_cited = wrap_deterministic_containerisation(containerisation)
    verified = VerifiedAppProfile(
        schema_version=1,
        commit_sha="a" * 40,
        ref="main",
        analysed_at=datetime(2026, 8, 10, tzinfo=UTC),
        languages=[LanguageBreakdown(name="Python", bytes=1200, share=1.0)],
        components=[
            VerifiedCited(
                value=comp_cited.value,
                confidence=comp_cited.confidence,
                citations=comp_cited.citations,
                source=comp_cited.source,
                verification=supported,
            )
        ],
        dependencies=[
            VerifiedCited(
                value=dep_cited.value,
                confidence=dep_cited.confidence,
                citations=dep_cited.citations,
                source=dep_cited.source,
                verification=supported,
            )
        ],
        containerisation=VerifiedCited(
            value=cont_cited.value,
            confidence=cont_cited.confidence,
            citations=cont_cited.citations,
            source=cont_cited.source,
            verification=supported,
        ),
        file_count=12,
        total_bytes=4096,
        notes=[],
    )

    assert verified.to_app_profile() == expected
    assert verified.dependencies[0].verification.verdict == "supported"
    assert verified.components[0].verification.verdict == "supported"
    assert verified.containerisation.verification.verdict == "supported"
