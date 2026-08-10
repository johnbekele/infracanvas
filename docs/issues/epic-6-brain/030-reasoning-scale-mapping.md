---
title: '[brain] Map the reasoning scale onto each provider parameter'
labels: tier:2, size:s, area:brain, epic:6-brain
---

### Epic

#7

### Context

#61 settled on one user-facing control with three positions: `fast`, `balanced`, `thorough`. No
provider has that control. Anthropic takes a thinking token budget, OpenAI takes a `reasoning_effort`
of low, medium or high, Gemini takes a thinking budget in tokens where zero disables it, Bedrock
takes whatever the underlying model family takes, and Ollama takes neither. Something has to turn one
choice into six different request bodies, and if that lives inside each call site the same slider
means different things depending on which code path built the request.

The awkward part is that the mapping is needed twice. The web app has to show what `thorough` will
cost before the user commits to it, so `packages/core/src/llm/reasoning.ts` maps the scale in
TypeScript; the brain has to send it, so it maps the scale again in Python. Two implementations of
one table drift, and they drift silently, because nothing fails when the TypeScript estimate says
16k thinking tokens and Python asks for 4k -- the user simply gets a bill that does not match the
preview.

**A shared fixture rather than generated code or careful review.** Generating the Python module from
the TypeScript one would add a build step to `services/brain` that exists for a single dictionary,
and a stale generated file is as wrong as a hand-edited one. Review does not work either: this is
exactly the kind of two-line change that gets approved. Instead one JSON file is normative and both
languages assert their own mapping against it, in both directions, so adding a provider or changing a
budget in one place fails the other language's test suite on the same pull request.

The fixture sits at `fixtures/llm/reasoning-scale.json` rather than inside either package.
`packages/core` cannot own it without `services/brain` reaching into a JavaScript package's source
tree, and the reverse is worse; a top-level directory is the only location neither side has to reach
across a boundary to read.

Spec: `docs/DELIVERY.md`

### Contract

```json
// fixtures/llm/reasoning-scale.json
{
  "version": 1,
  "scales": ["fast", "balanced", "thorough"],
  "providers": {
    "anthropic": {
      "parameter": "thinking.budget_tokens",
      "thinkingTokens": { "fast": null, "balanced": 4096, "thorough": 16384 },
      "maxTokens": { "fast": 4096, "balanced": 8192, "thorough": 24576 }
    },
    "openai": {
      "parameter": "reasoning_effort",
      "effort": { "fast": "low", "balanced": "medium", "thorough": "high" },
      "maxTokens": { "fast": 4096, "balanced": 8192, "thorough": 24576 }
    },
    "gemini": {
      "parameter": "thinking_config.thinking_budget",
      "thinkingTokens": { "fast": 0, "balanced": 4096, "thorough": 16384 },
      "maxTokens": { "fast": 4096, "balanced": 8192, "thorough": 24576 }
    },
    "bedrock": {
      "parameter": "delegated",
      "delegatesTo": { "anthropic.": "anthropic", "*": null },
      "maxTokens": { "fast": 4096, "balanced": 8192, "thorough": 24576 }
    },
    "ollama": {
      "parameter": "num_predict",
      "maxTokens": { "fast": 1024, "balanced": 2048, "thorough": 4096 }
    },
    "openai-compatible": {
      "parameter": "reasoning_effort",
      "effort": { "fast": "low", "balanced": "medium", "thorough": "high" },
      "requiresDeclaredSupport": true,
      "maxTokens": { "fast": 4096, "balanced": 8192, "thorough": 24576 }
    }
  }
}
```

`thinkingTokens: null` means the parameter is omitted entirely rather than sent as zero, because
Anthropic rejects a thinking block with a budget below its minimum. Gemini's zero is a real value: it
is how thinking is switched off there.

```python
# services/brain/src/brain/llm/reasoning.py
ReasoningScale = Literal["fast", "balanced", "thorough"]


@dataclass(frozen=True, slots=True)
class ReasoningSettings:
    max_tokens: int
    thinking_tokens: int | None
    effort: Literal["low", "medium", "high"] | None


def reasoning_settings(
    scale: ReasoningScale, provider: ProviderId, model: str
) -> ReasoningSettings:
    """Resolve the scale for a provider. `model` is read only for Bedrock,
    whose parameter depends on the family of the model behind it."""


def to_model_settings(
    settings: ReasoningSettings, provider: ProviderId
) -> ModelSettings:
    """Shape the resolved values into the pydantic-ai settings object for the
    provider, which is where the parameter names actually differ."""
```

`openai-compatible` sends `reasoning_effort` only when the credential row declares the endpoint
supports it. An endpoint that rejects unknown fields returns a 400 for every request otherwise, and a
provider a user pointed at themselves is precisely the one this code cannot make assumptions about.

The TypeScript side keeps whatever function `#61` exported from
`packages/core/src/llm/reasoning.ts`; this issue replaces its inline literals with values read from
the fixture and adds the test that pins them together.

### Files

- CREATE `fixtures/llm/reasoning-scale.json`
- CREATE `services/brain/src/brain/llm/reasoning.py`
- CREATE `services/brain/tests/test_reasoning.py`
- MODIFY `packages/core/src/llm/reasoning.ts` - source the per-provider numbers from the fixture
- CREATE `packages/core/src/llm/reasoning.test.ts`
- MODIFY `services/brain/src/brain/llm/providers.py` - accept the settings object when building a model

### Acceptance Criteria

- [ ] A provider present in the fixture but absent from the Python mapping fails the Python suite
- [ ] A provider present in the fixture but absent from the TypeScript mapping fails the core suite
- [ ] A provider mapped in either language but absent from the fixture also fails, so neither side can add a private entry
- [ ] `fast` sends no `thinking` block to Anthropic rather than a zero budget
- [ ] `fast` sends `thinking_budget: 0` to Gemini, which is how that provider disables it
- [ ] The thinking budget is always strictly below `max_tokens` for the same scale and provider
- [ ] Bedrock with an `anthropic.` model receives the Anthropic parameters, and with any other model receives none
- [ ] Ollama receives `num_predict` and no thinking or effort parameter
- [ ] `openai-compatible` omits `reasoning_effort` unless the credential declares support for it
- [ ] Changing a number in the fixture and running neither language's suite is impossible: both read it

### Required Tests

- `test_every_provider_in_the_fixture_has_a_python_mapping`
- `test_every_python_mapping_appears_in_the_fixture`
- `test_fast_omits_the_anthropic_thinking_block`
- `test_gemini_disables_thinking_with_an_explicit_zero`
- `test_thinking_budget_is_below_max_tokens_for_every_scale`
- `test_bedrock_delegates_to_the_underlying_model_family`
- `test_ollama_receives_no_reasoning_parameter`
- `test_openai_compatible_omits_effort_without_declared_support`
- `matches the shared reasoning fixture for every provider` (TypeScript)

### Performance Budget

n/a

### Out of Scope

- Do not change the three scale names or add a fourth; #61 settled that and the database stores it
- Do not add per-model overrides beyond the Bedrock family delegation the fixture already describes
- Do not implement token counting or budget enforcement; `060-token-budget-and-cache.md` owns it
- Do not move or restructure `packages/core/src/llm/reasoning.ts` beyond sourcing its numbers
- Do not add a settings UI for the scale; #61 owns that surface

### Dependencies

Blocked by #61, and by the registry in `docs/issues/epic-6-brain/020-provider-registry.md`.

### Verification

```bash
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest tests/test_reasoning.py -v
pnpm --filter @infracanvas/core test
pnpm typecheck
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
