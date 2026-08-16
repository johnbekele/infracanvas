"""Re-read cited spans and reject findings the span does not support."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Literal, Protocol, cast
from uuid import UUID

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from brain.profile.models import (
    Citation,
    Cited,
    CitedAppProfile,
    Component,
    Containerisation,
    DetectedDependency,
    Verification,
    VerifiedAppProfile,
    VerifiedCited,
)

Verdict = Literal["supported", "unsupported", "span_missing", "span_changed"]

MAX_CLAIMS_PER_JUDGE_CALL = 10
MAX_JUDGE_CALLS = 4


def _dependency_name_terms(value: object) -> list[str]:
    dependency = cast(DetectedDependency, value)
    return [dependency.name]


def _containerisation_port_terms(value: object) -> list[str]:
    containerisation = cast(Containerisation, value)
    return [f"EXPOSE {port}" for port in containerisation.exposed_ports]


def _component_manifest_terms(value: object) -> list[str]:
    component = cast(Component, value)
    return [Path(path).name for path in component.manifest_paths]


# Every term must appear in the re-read span, case-insensitively, after
# normalising quotes and separators. A dependency named "aws-sdk" must not be
# satisfied by the words "aws sdk" in a comment.
LITERAL_TERMS: dict[str, Callable[[object], list[str]]] = {
    "dependency.name": _dependency_name_terms,
    "containerisation.exposed_port": _containerisation_port_terms,
    "component.manifest_path": _component_manifest_terms,
}


class UnsupportedClaimError(ValueError):
    """A field the profile cannot omit has no citation that survived."""


@dataclass(frozen=True, slots=True)
class SpanSnapshot:
    text: str
    file_sha256: str


class SpanReader(Protocol):
    async def read(self, path: str, start_line: int, end_line: int) -> SpanSnapshot | None:
        """Return the current span, or None when the path or range is gone."""


class ClaimJudge(Protocol):
    async def supports(self, claims: Sequence[tuple[str, str]]) -> list[bool]:
        """(claim, span text) pairs to booleans, in order."""


@dataclass
class VerificationCounts:
    """How findings were settled. Used by the performance budget assertion."""

    literal: int = 0
    model: int = 0
    budget_exhausted: int = 0
    dropped: int = 0

    @property
    def settled(self) -> int:
        return self.literal + self.model + self.budget_exhausted

    @property
    def literal_share(self) -> float:
        return 0.0 if self.settled == 0 else self.literal / self.settled


def _normalize_quotes(text: str) -> str:
    return (
        text.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u00b4", "'")
        .replace("`", "'")
    )


def _normalize_separators(text: str) -> str:
    """Collapse whitespace runs. Hyphens and underscores stay so package names
    like `aws-sdk` are not satisfied by `aws sdk`."""
    return " ".join(_normalize_quotes(text).split())


def term_appears_in_span(term: str, span_text: str) -> bool:
    """Case-insensitive substring match after quote/whitespace normalisation."""
    needle = _normalize_separators(term).casefold()
    if not needle:
        return True
    haystack = _normalize_separators(span_text).casefold()
    return needle in haystack


def literal_terms_supported(terms: Sequence[str], span_text: str) -> bool:
    return all(term_appears_in_span(term, span_text) for term in terms)


@dataclass
class PoolSpanReader:
    """Re-read spans from the files/chunks tables for one ingestion run."""

    repository_id: UUID
    run_id: UUID
    pool: AsyncConnectionPool

    async def read(self, path: str, start_line: int, end_line: int) -> SpanSnapshot | None:
        if start_line < 1 or end_line < start_line:
            return None

        async with self.pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    """
                    SELECT id, sha256
                    FROM files
                    WHERE repository_id = %(repository_id)s
                      AND run_id = %(run_id)s
                      AND path = %(path)s
                    """,
                    {
                        "repository_id": self.repository_id,
                        "run_id": self.run_id,
                        "path": path,
                    },
                )
                file_row = await cur.fetchone()
                if file_row is None:
                    return None

                file_id = file_row["id"]
                file_sha256 = str(file_row["sha256"])

                await cur.execute(
                    """
                    SELECT start_line, end_line, content
                    FROM chunks
                    WHERE file_id = %(file_id)s
                      AND start_line <= %(end_line)s
                      AND end_line >= %(start_line)s
                    ORDER BY start_line
                    """,
                    {
                        "file_id": file_id,
                        "start_line": start_line,
                        "end_line": end_line,
                    },
                )
                chunk_rows = await cur.fetchall()

        lines: dict[int, str] = {}
        for chunk in chunk_rows:
            chunk_start = int(chunk["start_line"])
            content_lines = str(chunk["content"]).splitlines()
            for offset, line in enumerate(content_lines):
                line_no = chunk_start + offset
                if start_line <= line_no <= end_line:
                    lines[line_no] = line

        if not any(n in lines for n in range(start_line, end_line + 1)):
            return None

        ordered = [lines.get(n, "") for n in range(start_line, end_line + 1)]
        return SpanSnapshot(text="\n".join(ordered), file_sha256=file_sha256)


async def verify_citation(claim: str, citation: Citation, reader: SpanReader) -> Verification:
    """Re-read the span and decide. Returns `span_missing` when the path or
    range is gone and `span_changed` when the file SHA-256 differs from the one
    recorded at read time, so a moved line is never reported as a lie."""
    snapshot = await reader.read(citation.path, citation.start_line, citation.end_line)
    if snapshot is None:
        return Verification(
            verdict="span_missing",
            checked_by="literal",
            reason=(
                f"The cited span {citation.path}:{citation.start_line}-"
                f"{citation.end_line} is no longer available."
            ),
        )
    if snapshot.file_sha256 != citation.file_sha256:
        return Verification(
            verdict="span_changed",
            checked_by="literal",
            reason=f"The file {citation.path} has changed since it was cited.",
        )
    if term_appears_in_span(claim, snapshot.text):
        return Verification(
            verdict="supported",
            checked_by="literal",
            reason="The cited span contains the claimed terms.",
        )
    return Verification(
        verdict="unsupported",
        checked_by="literal",
        reason="The cited span does not contain the claimed terms.",
    )


@dataclass
class _PendingJudge:
    kind: Literal["dependency", "component", "containerisation"]
    summary: str
    claim: str
    span_text: str
    item: Cited[DetectedDependency] | Cited[Component] | Cited[Containerisation]
    index: int


@dataclass
class _VerifyState:
    notes: list[str]
    counts: VerificationCounts = field(default_factory=VerificationCounts)
    pending: list[_PendingJudge] = field(default_factory=list)
    kept_deps: list[VerifiedCited[DetectedDependency] | None] = field(default_factory=list)
    kept_components: list[VerifiedCited[Component] | None] = field(default_factory=list)
    container_verified: VerifiedCited[Containerisation] | None = None


def _dep_summary(dependency: DetectedDependency) -> str:
    return f"{dependency.ecosystem}:{dependency.name}"


def _component_summary(component: Component) -> str:
    return f"component:{component.path}"


def _claim_for_dependency(dependency: DetectedDependency) -> str:
    if dependency.capability is not None:
        return (
            f"This component depends on {dependency.name} "
            f"({dependency.ecosystem}) implying {dependency.capability}"
        )
    return f"This component depends on {dependency.name} ({dependency.ecosystem})"


def _claim_for_component(component: Component) -> str:
    manifests = (
        ", ".join(PurePosixPath(path).name for path in component.manifest_paths) or component.path
    )
    return f"Component {component.name} at {component.path} is kind {component.kind} ({manifests})"


def _claim_for_containerisation(containerisation: Containerisation) -> str:
    ports = ", ".join(str(port) for port in containerisation.exposed_ports) or "none"
    return f"Containerisation exposes ports {ports}"


def _span_missing(citation: Citation) -> Verification:
    return Verification(
        verdict="span_missing",
        checked_by="literal",
        reason=(
            f"The cited span {citation.path}:{citation.start_line}-"
            f"{citation.end_line} is no longer available."
        ),
    )


def _span_changed(citation: Citation) -> Verification:
    return Verification(
        verdict="span_changed",
        checked_by="literal",
        reason=f"The file {citation.path} has changed since it was cited.",
    )


async def _first_usable_span(
    citations: Sequence[Citation], reader: SpanReader
) -> tuple[Verification | None, SpanSnapshot | None]:
    """Return the first citation that is still present and unchanged.

    Prefer reporting span_changed over span_missing when both occur, so a
    moved line is never reported as a lie about the claim.
    """
    last_failure: Verification | None = None
    saw_changed = False
    for citation in citations:
        snapshot = await reader.read(citation.path, citation.start_line, citation.end_line)
        if snapshot is None:
            if not saw_changed:
                last_failure = _span_missing(citation)
            continue
        if snapshot.file_sha256 != citation.file_sha256:
            saw_changed = True
            last_failure = _span_changed(citation)
            continue
        return None, snapshot
    return last_failure, None


def _literal_check(key: str, value: object, span_text: str) -> Verification | None:
    """Return a Verification when this finding type has declared literal terms.

    None means the finding is not settled by the literal table and needs the
    judge.
    """
    extractor = LITERAL_TERMS.get(key)
    if extractor is None:
        return None
    terms = extractor(value)
    if literal_terms_supported(terms, span_text):
        return Verification(
            verdict="supported",
            checked_by="literal",
            reason="The cited span contains every required term.",
        )
    missing = [term for term in terms if not term_appears_in_span(term, span_text)]
    shown = ", ".join(repr(term) for term in missing) if missing else "required terms"
    return Verification(
        verdict="unsupported",
        checked_by="literal",
        reason=f"The cited span does not contain {shown}.",
    )


def _as_verified_dep(
    item: Cited[DetectedDependency], verification: Verification
) -> VerifiedCited[DetectedDependency]:
    return VerifiedCited(
        value=item.value,
        confidence=item.confidence,
        citations=item.citations,
        source=item.source,
        verification=verification,
    )


def _as_verified_component(
    item: Cited[Component], verification: Verification
) -> VerifiedCited[Component]:
    return VerifiedCited(
        value=item.value,
        confidence=item.confidence,
        citations=item.citations,
        source=item.source,
        verification=verification,
    )


def _as_verified_containerisation(
    item: Cited[Containerisation], verification: Verification
) -> VerifiedCited[Containerisation]:
    return VerifiedCited(
        value=item.value,
        confidence=item.confidence,
        citations=item.citations,
        source=item.source,
        verification=verification,
    )


def _record_drop(state: _VerifyState, label: str, summary: str, reason: str) -> None:
    state.notes.append(f"Dropped {label} {summary}: {reason}")
    state.counts.dropped += 1


async def _verify_dependency(
    *,
    state: _VerifyState,
    item: Cited[DetectedDependency],
    index: int,
    reader: SpanReader,
) -> None:
    summary = _dep_summary(item.value)
    failure, snapshot = await _first_usable_span(item.citations, reader)
    if failure is not None or snapshot is None:
        reason = failure.reason if failure is not None else "citation span is missing"
        _record_drop(state, "dependency", summary, reason)
        return

    literal = _literal_check("dependency.name", item.value, snapshot.text)
    if literal is not None:
        state.counts.literal += 1
        if literal.verdict == "supported":
            state.kept_deps[index] = _as_verified_dep(item, literal)
        else:
            _record_drop(state, "dependency", summary, literal.reason)
        return

    state.pending.append(
        _PendingJudge(
            kind="dependency",
            summary=summary,
            claim=_claim_for_dependency(item.value),
            span_text=snapshot.text,
            item=item,
            index=index,
        )
    )


async def _verify_component(
    *,
    state: _VerifyState,
    item: Cited[Component],
    index: int,
    reader: SpanReader,
) -> None:
    summary = _component_summary(item.value)
    failure, snapshot = await _first_usable_span(item.citations, reader)
    if failure is not None or snapshot is None:
        reason = failure.reason if failure is not None else "citation span is missing"
        _record_drop(state, "component", summary, reason)
        return

    literal = _literal_check("component.manifest_path", item.value, snapshot.text)
    if literal is not None:
        state.counts.literal += 1
        if literal.verdict == "supported":
            state.kept_components[index] = _as_verified_component(item, literal)
        else:
            _record_drop(state, "component", summary, literal.reason)
        return

    state.pending.append(
        _PendingJudge(
            kind="component",
            summary=summary,
            claim=_claim_for_component(item.value),
            span_text=snapshot.text,
            item=item,
            index=index,
        )
    )


async def verify_profile(
    profile: CitedAppProfile, reader: SpanReader, judge: ClaimJudge
) -> VerifiedAppProfile:
    """Verify every finding. Unsupported list entries are dropped and each one
    appended to `notes` with its reason. Raises UnsupportedClaimError when
    `containerisation` has no surviving citation."""
    state = _VerifyState(
        notes=list(profile.notes),
        kept_deps=[None] * len(profile.dependencies),
        kept_components=[None] * len(profile.components),
    )

    for index, dependency in enumerate(profile.dependencies):
        await _verify_dependency(state=state, item=dependency, index=index, reader=reader)

    for index, component in enumerate(profile.components):
        await _verify_component(state=state, item=component, index=index, reader=reader)

    container_item = profile.containerisation
    failure, snapshot = await _first_usable_span(container_item.citations, reader)
    if failure is not None or snapshot is None:
        reason = failure.reason if failure is not None else "citation span is missing"
        raise UnsupportedClaimError(f"containerisation citation did not survive: {reason}")

    container_literal = _literal_check(
        "containerisation.exposed_port", container_item.value, snapshot.text
    )
    if container_literal is not None:
        state.counts.literal += 1
        if container_literal.verdict != "supported":
            raise UnsupportedClaimError(
                f"containerisation citation did not survive: {container_literal.reason}"
            )
        state.container_verified = _as_verified_containerisation(container_item, container_literal)
    else:
        state.pending.append(
            _PendingJudge(
                kind="containerisation",
                summary="containerisation",
                claim=_claim_for_containerisation(container_item.value),
                span_text=snapshot.text,
                item=container_item,
                index=-1,
            )
        )

    judge_calls = 0
    while state.pending and judge_calls < MAX_JUDGE_CALLS:
        batch = state.pending[:MAX_CLAIMS_PER_JUDGE_CALL]
        state.pending = state.pending[MAX_CLAIMS_PER_JUDGE_CALL:]
        answers = await judge.supports([(entry.claim, entry.span_text) for entry in batch])
        judge_calls += 1

        for entry, supported in zip(batch, answers, strict=False):
            state.counts.model += 1
            if entry.kind == "containerisation":
                if not supported:
                    raise UnsupportedClaimError(
                        "containerisation citation did not survive: "
                        "the judge found the span does not support the claim"
                    )
                state.container_verified = _as_verified_containerisation(
                    container_item,
                    Verification(
                        verdict="supported",
                        checked_by="model",
                        reason="The judge found the cited span supports the claim.",
                    ),
                )
                continue

            if supported:
                verification = Verification(
                    verdict="supported",
                    checked_by="model",
                    reason="The judge found the cited span supports the claim.",
                )
                if entry.kind == "dependency":
                    state.kept_deps[entry.index] = _as_verified_dep(
                        cast(Cited[DetectedDependency], entry.item), verification
                    )
                else:
                    state.kept_components[entry.index] = _as_verified_component(
                        cast(Cited[Component], entry.item), verification
                    )
            else:
                reason = "the judge found the cited span does not support the claim"
                label = "dependency" if entry.kind == "dependency" else "component"
                _record_drop(state, label, entry.summary, reason)

    for entry in state.pending:
        reason = "the verification judge budget was exhausted before this claim was checked"
        state.counts.budget_exhausted += 1
        if entry.kind == "containerisation":
            raise UnsupportedClaimError(f"containerisation citation did not survive: {reason}")
        label = "dependency" if entry.kind == "dependency" else "component"
        _record_drop(state, label, entry.summary, reason)

    if state.container_verified is None:
        raise UnsupportedClaimError(
            "containerisation citation did not survive: no standing verification"
        )

    kept_deps = [dep for dep in state.kept_deps if dep is not None]
    kept_components = [comp for comp in state.kept_components if comp is not None]
    if any(dep.verification.verdict != "supported" for dep in kept_deps):
        raise RuntimeError("verifier produced a non-supported dependency")
    if any(comp.verification.verdict != "supported" for comp in kept_components):
        raise RuntimeError("verifier produced a non-supported component")
    if state.container_verified.verification.verdict != "supported":
        raise RuntimeError("verifier produced a non-supported containerisation finding")

    verified = VerifiedAppProfile(
        schema_version=profile.schema_version,
        commit_sha=profile.commit_sha,
        ref=profile.ref,
        analysed_at=profile.analysed_at,
        languages=profile.languages,
        components=kept_components,
        dependencies=kept_deps,
        containerisation=state.container_verified,
        file_count=profile.file_count,
        total_bytes=profile.total_bytes,
        notes=state.notes,
    )
    verified.__dict__["_verification_counts"] = state.counts
    return verified


def verification_counts(profile: VerifiedAppProfile) -> VerificationCounts:
    counts = profile.__dict__.get("_verification_counts")
    if isinstance(counts, VerificationCounts):
        return counts
    return VerificationCounts()
