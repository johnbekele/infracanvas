"""Metered agent runs: cache, reserve, call, settle, store."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, TypeVar, cast
from uuid import UUID

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

from brain.llm.budget import record_cache_hit, reserve, settle
from brain.llm.cache import ReasoningScale, cache_key, lookup, store
from brain.llm.providers import ProviderCredential

D = TypeVar("D")
T = TypeVar("T")


def estimate_tokens(text: str, max_output: int) -> int:
    """Pessimistic pre-flight: characters / 3.5 plus the scale's max output."""
    return math.ceil(len(text) / 3.5) + max_output


def _coerce_output(output_type: object, raw: object) -> Any:
    if isinstance(output_type, type) and issubclass(output_type, BaseModel):
        return output_type.model_validate(raw)
    return raw


def _dump_output(value: object) -> object:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    return value


def _usage_tokens(result: object) -> tuple[int, int]:
    usage = getattr(result, "usage", None)
    if callable(usage):
        usage = usage()
    if usage is None:
        return 0, 0
    return int(getattr(usage, "input_tokens", 0) or 0), int(getattr(usage, "output_tokens", 0) or 0)


@dataclass(slots=True)
class MeteredRunner:
    """Every model call in this service goes through here."""

    model: Model
    model_settings: ModelSettings
    credential: ProviderCredential | None = None
    scale: ReasoningScale = "balanced"
    prompt_version: str = "v1"
    max_output_tokens: int = 2048
    _passthrough: bool = False

    @classmethod
    def passthrough(cls, model: Model, model_settings: ModelSettings) -> MeteredRunner:
        """Unit-test path: no budget, no cache, still the only place that calls
        ``agent.run``."""
        return cls(model=model, model_settings=model_settings, _passthrough=True)

    async def run(
        self,
        agent: Agent[D, T],
        prompt: str,
        *,
        deps: D,
        purpose: str,
        user_id: UUID,
    ) -> T:
        """Cache lookup, reserve, run, settle, store."""
        if self._passthrough or self.credential is None:
            result = await agent.run(
                prompt,
                model=self.model,
                deps=deps,
                model_settings=self.model_settings,
            )
            return result.output

        credential = self.credential
        messages = [ModelRequest(parts=[UserPromptPart(content=prompt)])]
        key = cache_key(
            user_id,
            credential,
            self.scale,
            messages,
            self.prompt_version,
        )

        cached = await lookup(key)
        if cached is not None:
            await record_cache_hit(user_id, credential, purpose, self.scale)
            return cast(T, _coerce_output(agent.output_type, cached.response))

        estimated = estimate_tokens(prompt, self.max_output_tokens)
        reservation_id = await reserve(
            user_id,
            credential,
            purpose,
            estimated,
            reasoning=self.scale,
        )

        try:
            result = await agent.run(
                prompt,
                model=self.model,
                deps=deps,
                model_settings=self.model_settings,
            )
        except Exception:
            # Release the hold; we never reached a billable completion.
            await settle(reservation_id, 0, 0)
            raise

        input_tokens, output_tokens = _usage_tokens(result)
        await settle(reservation_id, input_tokens, output_tokens)
        await store(
            key,
            credential,
            _dump_output(result.output),
            input_tokens,
            output_tokens,
            user_id=user_id,
            reasoning=self.scale,
        )
        return result.output
