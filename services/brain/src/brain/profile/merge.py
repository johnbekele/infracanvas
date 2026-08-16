"""Merge agent findings into a deterministic AppProfile.

The agent adds; it does not overrule. Unsupported, low-confidence, and
conflicting findings become notes rather than provisioned infrastructure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from brain.profile.models import (
    AGENT_CONFIDENCE_CEILING,
    MIN_CONFIDENCE,
    AgentFindings,
    AppProfileInput,
    Citation,
    Cited,
    CitedAppProfile,
    Component,
    Containerisation,
    DetectedDependency,
    Ecosystem,
)


@dataclass(frozen=True, slots=True)
class RejectedFinding:
    kind: Literal["dependency", "component"]
    summary: str
    reason: str


def citation_was_returned(citation: Citation, reads: list[Citation]) -> bool:
    """True when a tool returned a span that covers this citation."""
    for read in reads:
        if (
            read.path == citation.path
            and read.file_sha256 == citation.file_sha256
            and read.start_line <= citation.start_line
            and citation.end_line <= read.end_line
        ):
            return True
    return False


def _dep_key(dependency: DetectedDependency) -> tuple[str, Ecosystem]:
    return (dependency.name, dependency.ecosystem)


def _component_key(component: Component) -> str:
    return component.path


def _summarise_dep(dependency: DetectedDependency) -> str:
    return f"{dependency.ecosystem}:{dependency.name}"


def _summarise_component(component: Component) -> str:
    return f"component:{component.path}"


def _deterministic_citation(path: str) -> Citation:
    return Citation(path=path, start_line=1, end_line=1, file_sha256="0" * 64)


def wrap_deterministic_dependency(dependency: DetectedDependency) -> Cited[DetectedDependency]:
    return Cited(
        value=dependency,
        confidence=1.0,
        citations=[_deterministic_citation(dependency.source_path)],
        source="deterministic",
    )


def wrap_deterministic_component(component: Component) -> Cited[Component]:
    path = component.manifest_paths[0] if component.manifest_paths else component.path
    return Cited(
        value=component,
        confidence=1.0,
        citations=[_deterministic_citation(path)],
        source="deterministic",
    )


def wrap_deterministic_containerisation(
    containerisation: Containerisation,
) -> Cited[Containerisation]:
    path = (
        containerisation.dockerfiles[0]
        if containerisation.dockerfiles
        else containerisation.compose_files[0]
        if containerisation.compose_files
        else "."
    )
    return Cited(
        value=containerisation,
        confidence=1.0,
        citations=[_deterministic_citation(path)],
        source="deterministic",
    )


def sanitize_agent_findings(
    findings: AgentFindings,
    reads: list[Citation],
    *,
    orm_keys: set[tuple[str, Ecosystem]] | None = None,
) -> tuple[AgentFindings, list[RejectedFinding], list[str]]:
    """Drop unsupported findings and clamp confidence. Returns kept, rejected, notes."""
    notes: list[str] = list(findings.notes)
    rejected: list[RejectedFinding] = []
    kept_deps: list[Cited[DetectedDependency]] = []
    kept_components: list[Cited[Component]] = []
    known_orms: set[tuple[str, Ecosystem]] = orm_keys or set()

    for dep_item in findings.dependencies:
        summary = _summarise_dep(dep_item.value)
        if dep_item.source != "agent":
            rejected.append(
                RejectedFinding(
                    kind="dependency",
                    summary=summary,
                    reason="agent findings must carry source='agent'",
                )
            )
            notes.append(f"Discarded {summary}: agent findings must carry source='agent'")
            continue

        if not dep_item.citations or not all(
            citation_was_returned(citation, reads) for citation in dep_item.citations
        ):
            reason = "citation was never returned by a tool"
            rejected.append(RejectedFinding(kind="dependency", summary=summary, reason=reason))
            notes.append(f"Discarded {summary}: {reason}")
            continue

        if dep_item.confidence < MIN_CONFIDENCE:
            reason = f"confidence {dep_item.confidence} is below {MIN_CONFIDENCE}"
            rejected.append(RejectedFinding(kind="dependency", summary=summary, reason=reason))
            notes.append(f"Low-confidence finding for {summary} recorded as a note: {reason}")
            continue

        confidence = dep_item.confidence
        value = dep_item.value
        if confidence > AGENT_CONFIDENCE_CEILING:
            notes.append(
                f"Clamped confidence for {summary} from {confidence} to {AGENT_CONFIDENCE_CEILING}"
            )
            confidence = AGENT_CONFIDENCE_CEILING

        if _dep_key(value) in known_orms and value.capability is not None:
            notes.append(
                f"Cleared capability on ORM dependency {summary}; "
                "the deterministic pass leaves capability unset for ORMs"
            )
            value = value.model_copy(update={"capability": None})

        kept_deps.append(
            Cited(
                value=value,
                confidence=confidence,
                citations=dep_item.citations,
                source="agent",
            )
        )

    for component_item in findings.components:
        summary = _summarise_component(component_item.value)
        if component_item.source != "agent":
            rejected.append(
                RejectedFinding(
                    kind="component",
                    summary=summary,
                    reason="agent findings must carry source='agent'",
                )
            )
            notes.append(f"Discarded {summary}: agent findings must carry source='agent'")
            continue

        if not component_item.citations or not all(
            citation_was_returned(citation, reads) for citation in component_item.citations
        ):
            reason = "citation was never returned by a tool"
            rejected.append(RejectedFinding(kind="component", summary=summary, reason=reason))
            notes.append(f"Discarded {summary}: {reason}")
            continue

        if component_item.confidence < MIN_CONFIDENCE:
            reason = f"confidence {component_item.confidence} is below {MIN_CONFIDENCE}"
            rejected.append(RejectedFinding(kind="component", summary=summary, reason=reason))
            notes.append(f"Low-confidence finding for {summary} recorded as a note: {reason}")
            continue

        confidence = component_item.confidence
        if confidence > AGENT_CONFIDENCE_CEILING:
            notes.append(
                f"Clamped confidence for {summary} from {confidence} to {AGENT_CONFIDENCE_CEILING}"
            )
            confidence = AGENT_CONFIDENCE_CEILING

        kept_components.append(
            Cited(
                value=component_item.value,
                confidence=confidence,
                citations=component_item.citations,
                source="agent",
            )
        )

    kept = AgentFindings(components=kept_components, dependencies=kept_deps, notes=[])
    return kept, rejected, notes


def merge_profiles(
    deterministic: AppProfileInput,
    agent: AgentFindings,
    *,
    extra_notes: list[str] | None = None,
) -> CitedAppProfile:
    """Combine deterministic and agent findings. Deterministic wins on conflict."""
    notes = list(deterministic.notes)
    if extra_notes:
        notes.extend(extra_notes)
    notes.extend(agent.notes)

    det_deps = {
        _dep_key(dep): wrap_deterministic_dependency(dep) for dep in deterministic.dependencies
    }
    det_components = {
        _component_key(component): wrap_deterministic_component(component)
        for component in deterministic.components
    }

    orm_keys = {_dep_key(dep) for dep in deterministic.dependencies if dep.category == "orm"}

    merged_deps = dict(det_deps)
    for dep_item in agent.dependencies:
        dep_key = _dep_key(dep_item.value)
        if dep_key in det_deps:
            notes.append(
                f"Kept deterministic finding for {_summarise_dep(dep_item.value)}; "
                "ignored conflicting agent finding"
            )
            continue
        cleared = dep_item
        if dep_key in orm_keys and dep_item.value.capability is not None:
            notes.append(f"Cleared capability on ORM dependency {_summarise_dep(dep_item.value)}")
            cleared = Cited(
                value=dep_item.value.model_copy(update={"capability": None}),
                confidence=dep_item.confidence,
                citations=dep_item.citations,
                source=dep_item.source,
            )
        merged_deps[dep_key] = cleared

    merged_components = dict(det_components)
    for component_item in agent.components:
        component_key = _component_key(component_item.value)
        if component_key in det_components:
            notes.append(
                f"Kept deterministic finding for {_summarise_component(component_item.value)}; "
                "ignored conflicting agent finding"
            )
            continue
        merged_components[component_key] = component_item

    return CitedAppProfile(
        schema_version=1,
        commit_sha=deterministic.commit_sha,
        ref=deterministic.ref,
        analysed_at=deterministic.analysed_at,
        languages=deterministic.languages,
        components=list(merged_components.values()),
        dependencies=list(merged_deps.values()),
        containerisation=wrap_deterministic_containerisation(deterministic.containerisation),
        file_count=deterministic.file_count,
        total_bytes=deterministic.total_bytes,
        notes=notes,
    )


def format_rejection_prompt(rejected: list[RejectedFinding]) -> str:
    if not rejected:
        return "All findings were accepted."
    lines = [
        "The following findings were rejected. Resubmit only corrected findings "
        "with citations that match spans the tools returned. Do not invent new "
        "claims in this repair round.",
        "",
    ]
    for item in rejected:
        lines.append(f"- ({item.kind}) {item.summary}: {item.reason}")
    return "\n".join(lines)
