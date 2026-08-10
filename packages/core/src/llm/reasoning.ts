/**
 * How hard the model should think, expressed once.
 *
 * The difference between a cheap draft architecture and a slow careful one is a
 * per-request parameter, and every provider spells it differently: OpenAI has a
 * reasoning effort, Anthropic has a thinking token budget, Ollama has neither
 * and only takes a temperature. Exposing that difference to the user would mean
 * asking a platform engineer to learn five vocabularies to answer one question.
 */
import type { LlmProvider } from './providers';

export type ReasoningScale = 'fast' | 'balanced' | 'thorough';

export const reasoningScales: { id: ReasoningScale; label: string; description: string }[] = [
  {
    id: 'fast',
    label: 'Fast',
    description: 'A first pass. Cheapest, and enough to see the shape of a proposal.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'The default. Enough deliberation to catch the obvious mistakes.',
  },
  {
    id: 'thorough',
    label: 'Thorough',
    description: 'Slow and expensive. For a design you intend to deploy.',
  },
];

export function isReasoningScale(value: unknown): value is ReasoningScale {
  return value === 'fast' || value === 'balanced' || value === 'thorough';
}

/** Rough output ceiling per scale, shared by the providers that take one. */
const MAX_TOKENS: Record<ReasoningScale, number> = {
  fast: 2_048,
  balanced: 8_192,
  thorough: 32_768,
};

const OPENAI_EFFORT: Record<ReasoningScale, string> = {
  fast: 'low',
  balanced: 'medium',
  thorough: 'high',
};

/** Anthropic budgets thinking tokens directly, and they come out of max_tokens. */
const ANTHROPIC_THINKING: Record<ReasoningScale, number> = {
  fast: 1_024,
  balanced: 4_096,
  thorough: 16_384,
};

/**
 * The request parameters one scale means for one provider.
 *
 * Returns a flat map rather than a typed per-provider shape because the caller
 * spreads it into a request body whose schema belongs to the provider's own
 * client library, and mirroring five of those here would be a copy that goes
 * stale.
 */
export function reasoningParams(
  provider: LlmProvider,
  scale: ReasoningScale
): Record<string, string | number> {
  switch (provider) {
    case 'openai':
      return { reasoning_effort: OPENAI_EFFORT[scale], max_output_tokens: MAX_TOKENS[scale] };

    case 'anthropic':
      return { thinking_budget_tokens: ANTHROPIC_THINKING[scale], max_tokens: MAX_TOKENS[scale] };

    case 'bedrock':
      // Bedrock passes through to the underlying model, and the only parameter
      // every model on it accepts is a token ceiling.
      return { maxTokens: MAX_TOKENS[scale] };

    case 'google':
      return { thinkingBudget: ANTHROPIC_THINKING[scale], maxOutputTokens: MAX_TOKENS[scale] };

    case 'ollama':
      // No reasoning control exists here, so the scale becomes the one lever
      // that does change how much a local model explores.
      return {
        num_predict: MAX_TOKENS[scale],
        temperature: scale === 'fast' ? 0.2 : scale === 'balanced' ? 0.4 : 0.7,
      };
  }
}
