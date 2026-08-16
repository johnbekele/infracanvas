"""CitedAppProfile serialises to the TypeScript AppProfile wire shape."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from brain.profile.merge import (
    wrap_deterministic_component,
    wrap_deterministic_containerisation,
    wrap_deterministic_dependency,
)
from brain.profile.models import (
    CitedAppProfile,
    Component,
    Containerisation,
    DetectedDependency,
    LanguageBreakdown,
)

FIXTURE = Path(__file__).parent / "fixtures" / "profile" / "expected_profile.json"


def test_serialises_to_the_typescript_app_profile_shape() -> None:
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
    cited = CitedAppProfile(
        schema_version=1,
        commit_sha="a" * 40,
        ref="main",
        analysed_at=datetime(2026, 8, 10, tzinfo=UTC),
        languages=[LanguageBreakdown(name="Python", bytes=1200, share=1.0)],
        components=[wrap_deterministic_component(component)],
        dependencies=[wrap_deterministic_dependency(dependency)],
        containerisation=wrap_deterministic_containerisation(containerisation),
        file_count=12,
        total_bytes=4096,
        notes=[],
    )

    actual = cited.to_app_profile()

    assert actual["schemaVersion"] == 1
    assert actual == expected
