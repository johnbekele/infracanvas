"""AppProfile agent: fill gaps the deterministic pass cannot see."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

from brain.profile.merge import (
    format_rejection_prompt,
    merge_profiles,
    sanitize_agent_findings,
)
from brain.profile.models import AgentFindings, AppProfileInput, CitedAppProfile
from brain.profile.tools import ProfileDeps, list_files, read_span, search_text

SYSTEM_PROMPT = """\
You enrich an application profile by reading repository code through the provided
tools. The deterministic pass already classified manifests and Dockerfiles; you
add only what that pass cannot see: databases reached through hand-rolled
helpers, workers without a job framework in the manifest, queues used via raw
SDK calls, and similar.

Rules:
- Every finding must cite a path, line range, and file SHA-256 that a tool
  actually returned in this run.
- Confidence is your probability the claim holds; stay at or below 0.9.
- Do not override a dependency the deterministic profile already lists.
- Do not set capability on a dependency the deterministic pass marked as an ORM.
- Prefer fewer high-quality findings over speculative ones.
"""


@dataclass(frozen=True, slots=True)
class ReasoningSettings:
    """Provider-resolved generation settings.

    Matches `docs/issues/epic-6-brain/030-reasoning-scale-mapping.md`. When
    `brain.llm.reasoning` lands, call sites should prefer that module; this
    dataclass keeps the profile agent runnable in the meantime.
    """

    max_tokens: int
    thinking_tokens: int | None = None
    effort: Literal["low", "medium", "high"] | None = None


def _to_model_settings(reasoning: ReasoningSettings) -> ModelSettings:
    return ModelSettings(max_tokens=reasoning.max_tokens)


profile_agent: Agent[ProfileDeps, AgentFindings] = Agent(
    deps_type=ProfileDeps,
    output_type=AgentFindings,
    system_prompt=SYSTEM_PROMPT,
    tools=[list_files, read_span, search_text],
)


def _initial_prompt(deterministic: AppProfileInput) -> str:
    payload = deterministic.model_dump(by_alias=True, mode="json")
    return (
        "Here is the deterministic AppProfile for this repository. Find "
        "additional components or dependencies that manifests do not declare, "
        "using the tools. Return only agent findings with citations.\n\n"
        f"{payload}"
    )


async def build_profile(
    deterministic: AppProfileInput,
    deps: ProfileDeps,
    model: Model,
    reasoning: ReasoningSettings,
) -> CitedAppProfile:
    """Run the agent, discard unsupported findings, and merge what survives
    into the deterministic profile. Deterministic findings win on conflict.

    One repair round: rejected findings are returned to the agent with the
    reason, and the run ends after the second attempt regardless.
    """
    model_settings = _to_model_settings(reasoning)
    orm_keys = {
        (dep.name, dep.ecosystem) for dep in deterministic.dependencies if dep.category == "orm"
    }

    first = await profile_agent.run(
        _initial_prompt(deterministic),
        model=model,
        deps=deps,
        model_settings=model_settings,
    )
    kept, rejected, notes = sanitize_agent_findings(first.output, deps.reads, orm_keys=orm_keys)

    if rejected:
        second = await profile_agent.run(
            format_rejection_prompt(rejected),
            model=model,
            deps=deps,
            model_settings=model_settings,
        )
        repaired, rejected_again, repair_notes = sanitize_agent_findings(
            second.output, deps.reads, orm_keys=orm_keys
        )
        notes.extend(repair_notes)
        kept = AgentFindings(
            components=[*kept.components, *repaired.components],
            dependencies=[*kept.dependencies, *repaired.dependencies],
            notes=[],
        )
        for item in rejected_again:
            notes.append(f"Gave up on {item.summary} after repair: {item.reason}")

    return merge_profiles(deterministic, kept, extra_notes=notes)
