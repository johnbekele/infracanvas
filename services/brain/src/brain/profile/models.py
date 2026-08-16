"""AppProfile shapes with a citation envelope.

Field-for-field restatement of `packages/core/src/analysis/profile.ts`. The
envelope is stripped by `CitedAppProfile.to_app_profile()` so the wire shape
matches the TypeScript interface.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

PROFILE_SCHEMA_VERSION = 1

# Anything below this is reported as a note instead of a finding. A profile is
# an input to provisioning, so a coin toss does not belong in it.
MIN_CONFIDENCE = 0.5

# Deterministic findings are 1.0; the agent is capped here so the two stay
# distinguishable in the output.
AGENT_CONFIDENCE_CEILING = 0.9

Ecosystem = Literal["npm", "pypi", "go", "cargo", "maven", "rubygems", "composer"]

Capability = Literal[
    "http-server",
    "graphql",
    "grpc",
    "websocket",
    "frontend",
    "mcp-server",
    "postgres",
    "mysql",
    "mongodb",
    "redis",
    "dynamodb",
    "cassandra",
    "clickhouse",
    "graph-db",
    "elasticsearch",
    "vector-search",
    "kafka",
    "rabbitmq",
    "background-jobs",
    "scheduled-jobs",
    "streaming",
    "workflow-orchestration",
    "llm-api",
    "embeddings",
    "ml-inference",
    "gpu-inference",
    "document-processing",
    "feature-store",
    "object-storage",
    "email",
    "identity",
    "observability",
    "secrets",
]

DependencyCategory = Literal[
    "web-framework",
    "frontend-framework",
    "datastore",
    "cache",
    "queue",
    "search",
    "vector",
    "orm",
    "cloud-sdk",
    "ml",
    "llm",
    "agent",
    "document",
    "workflow",
    "observability",
    "auth",
    "other",
]

ComponentKind = Literal[
    "api",
    "worker",
    "frontend",
    "ml-service",
    "cron",
    "library",
    "test",
    "example",
    "unknown",
]


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Citation(BaseModel):
    path: str
    start_line: int  # 1-based, inclusive
    end_line: int  # inclusive
    # Of the whole file as read. Lets a later check tell "the claim was wrong"
    # apart from "the file moved underneath the claim".
    file_sha256: str


class Cited[T](BaseModel):
    value: T
    # The agent's stated probability that the claim holds. Deterministic
    # findings are 1.0 and the agent is capped at 0.9, so the two are always
    # distinguishable in the output.
    confidence: float = Field(ge=0.0, le=1.0)
    citations: list[Citation] = Field(min_length=1)
    source: Literal["deterministic", "agent"]


Verdict = Literal["supported", "unsupported", "span_missing", "span_changed"]


class Verification(BaseModel):
    verdict: Verdict
    checked_by: Literal["literal", "model", "budget-exhausted"]
    # Shown to the user next to the dropped finding, so it must read as English.
    reason: str


class VerifiedCited[T](Cited[T]):
    verification: Verification


class LanguageBreakdown(_CamelModel):
    name: str
    bytes: int
    share: float


class DetectedDependency(_CamelModel):
    name: str
    ecosystem: Ecosystem
    category: DependencyCategory
    capability: Capability | None
    source_path: str


class Component(_CamelModel):
    path: str
    name: str
    kind: ComponentKind
    ecosystems: list[Ecosystem]
    manifest_paths: list[str]
    dependency_count: int
    capabilities: list[Capability]
    dependencies: list[DetectedDependency]
    dockerfiles: list[str]
    exposed_ports: list[int]
    compose_service: str | None
    deployable: bool


class Containerisation(_CamelModel):
    dockerfiles: list[str]
    compose_files: list[str]
    exposed_ports: list[int]


class AppProfileInput(_CamelModel):
    """Deterministic profile, without the citation envelope."""

    schema_version: Literal[1] = 1
    commit_sha: str
    ref: str
    analysed_at: datetime
    languages: list[LanguageBreakdown]
    components: list[Component]
    dependencies: list[DetectedDependency]
    containerisation: Containerisation
    file_count: int
    total_bytes: int
    notes: list[str]


class AgentFindings(BaseModel):
    """Structured agent output: only the findings it wants to add."""

    components: list[Cited[Component]] = Field(default_factory=list)
    dependencies: list[Cited[DetectedDependency]] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class AppProfile(_CamelModel):
    """Wire shape matching the TypeScript `AppProfile` (schema version 1)."""

    schema_version: Literal[1]
    commit_sha: str
    ref: str
    analysed_at: datetime
    languages: list[LanguageBreakdown]
    components: list[Component]
    dependencies: list[DetectedDependency]
    containerisation: Containerisation
    file_count: int
    total_bytes: int
    notes: list[str]


class CitedAppProfile(_CamelModel):
    schema_version: Literal[1]
    commit_sha: str
    ref: str
    analysed_at: datetime
    languages: list[LanguageBreakdown]
    components: list[Cited[Component]]
    dependencies: list[Cited[DetectedDependency]]
    containerisation: Cited[Containerisation]
    file_count: int
    total_bytes: int
    notes: list[str]

    def to_app_profile(self) -> dict[str, object]:
        """Strip the envelope. The result validates against the TypeScript
        `AppProfile` in packages/core/src/analysis/profile.ts."""
        plain = AppProfile(
            schema_version=self.schema_version,
            commit_sha=self.commit_sha,
            ref=self.ref,
            analysed_at=self.analysed_at,
            languages=self.languages,
            components=[item.value for item in self.components],
            dependencies=[item.value for item in self.dependencies],
            containerisation=self.containerisation.value,
            file_count=self.file_count,
            total_bytes=self.total_bytes,
            notes=self.notes,
        )
        return plain.model_dump(by_alias=True, mode="json")


class VerifiedAppProfile(_CamelModel):
    """CitedAppProfile after every finding has a standing, supported citation."""

    schema_version: Literal[1]
    commit_sha: str
    ref: str
    analysed_at: datetime
    languages: list[LanguageBreakdown]
    components: list[VerifiedCited[Component]]
    dependencies: list[VerifiedCited[DetectedDependency]]
    containerisation: VerifiedCited[Containerisation]
    file_count: int
    total_bytes: int
    notes: list[str]

    def to_app_profile(self) -> dict[str, object]:
        """Strip the citation and verification envelopes."""
        plain = AppProfile(
            schema_version=self.schema_version,
            commit_sha=self.commit_sha,
            ref=self.ref,
            analysed_at=self.analysed_at,
            languages=self.languages,
            components=[item.value for item in self.components],
            dependencies=[item.value for item in self.dependencies],
            containerisation=self.containerisation.value,
            file_count=self.file_count,
            total_bytes=self.total_bytes,
            notes=self.notes,
        )
        return plain.model_dump(by_alias=True, mode="json")
