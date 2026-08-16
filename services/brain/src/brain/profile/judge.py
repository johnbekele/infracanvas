"""Fresh-call claim judge: claim and span only, no repository tools."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

from brain.llm.metering import MeteredRunner

# Matches the shared `fast` ceiling in packages/core/src/llm/reasoning.ts.
# Issue 030 will replace this constant with reasoning_settings("fast", ...).
FAST_MAX_TOKENS = 2048

JUDGE_SYSTEM_PROMPT = """\
You decide whether a cited source span supports a claim.

You receive a list of (claim, span text) pairs. For each pair, decide whether
the span text supports the claim. Return one boolean per pair, in the same
order.

You have no repository access and no prior conversation. Judge only from the
claim and the span text you are given.
"""


class JudgeBatchResult(BaseModel):
    supported: list[bool] = Field(min_length=0)


class Judge:
    """Boolean support checks in batches, always at the fast reasoning scale."""

    # Intentionally empty: the judge must not gain repository tools later by
    # accident. Tests assert this stays vacant.
    repository_tools: tuple[()] = ()

    def __init__(
        self,
        model: Model,
        *,
        meter: MeteredRunner | None = None,
        user_id: UUID | None = None,
    ) -> None:
        self._model = model
        self._settings = ModelSettings(max_tokens=FAST_MAX_TOKENS)
        # No deps_type and no tools: a fresh call with only the prompt.
        self._agent: Agent[None, JudgeBatchResult] = Agent(
            output_type=JudgeBatchResult,
            system_prompt=JUDGE_SYSTEM_PROMPT,
        )
        self._meter = meter or MeteredRunner.passthrough(model=model, model_settings=self._settings)
        self._user_id = user_id if user_id is not None else UUID(int=0)

    @property
    def reasoning_scale(self) -> str:
        return "fast"

    @property
    def model_settings(self) -> ModelSettings:
        return self._settings

    async def supports(self, claims: Sequence[tuple[str, str]]) -> list[bool]:
        """(claim, span text) pairs to booleans, in order, in one call per
        batch of ten. No repository access and no conversation history."""
        if not claims:
            return []

        lines = [
            "For each numbered pair, does the span support the claim?",
            "Return supported as a boolean list in the same order.",
            "",
        ]
        for index, (claim, span) in enumerate(claims, start=1):
            lines.append(f"{index}. Claim: {claim}")
            lines.append(f"   Span: {span}")
            lines.append("")

        result = await self._meter.run(
            self._agent,
            "\n".join(lines),
            deps=None,
            purpose="judge",
            user_id=self._user_id,
        )
        answers = list(result.supported)
        # Fail closed when the model returns the wrong arity.
        if len(answers) < len(claims):
            answers.extend([False] * (len(claims) - len(answers)))
        return answers[: len(claims)]
