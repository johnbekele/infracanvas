import { describe, expect, it } from 'vitest';
import { isReasoningScale, reasoningParams, reasoningScales } from './reasoning';
import { getProvider, isLlmProvider, llmProviders } from './providers';

describe('reasoningParams', () => {
  it('maps the reasoning scale to provider-specific parameters', () => {
    // One choice, five vocabularies. The point of the mapping is that the user
    // never sees the difference.
    expect(reasoningParams('openai', 'thorough')).toHaveProperty('reasoning_effort', 'high');
    expect(reasoningParams('anthropic', 'thorough')).toHaveProperty('thinking_budget_tokens');
    expect(reasoningParams('ollama', 'thorough')).toHaveProperty('num_predict');
    expect(reasoningParams('bedrock', 'thorough')).toHaveProperty('maxTokens');
    expect(reasoningParams('google', 'thorough')).toHaveProperty('thinkingBudget');
  });

  it('spends more as the scale rises, for every provider', () => {
    for (const provider of llmProviders) {
      const fast = Object.values(reasoningParams(provider.id, 'fast')).filter(
        (value): value is number => typeof value === 'number'
      );
      const thorough = Object.values(reasoningParams(provider.id, 'thorough')).filter(
        (value): value is number => typeof value === 'number'
      );

      expect(Math.max(...thorough)).toBeGreaterThan(Math.max(...fast));
    }
  });

  it('returns something usable for every scale and provider', () => {
    for (const provider of llmProviders) {
      for (const scale of reasoningScales) {
        expect(Object.keys(reasoningParams(provider.id, scale.id)).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('providers', () => {
  it('requires a key only where there is an account to have one', () => {
    expect(getProvider('openai')?.requiresApiKey).toBe(true);
    expect(getProvider('anthropic')?.requiresApiKey).toBe(true);
    // Bedrock uses the process credentials, and Ollama is a local process.
    expect(getProvider('bedrock')?.requiresApiKey).toBe(false);
    expect(getProvider('ollama')?.requiresApiKey).toBe(false);
  });

  it('offers at least one model for each provider', () => {
    for (const provider of llmProviders) {
      expect(provider.suggestedModels.length).toBeGreaterThan(0);
    }
  });

  it('rejects a provider name it does not know', () => {
    expect(isLlmProvider('cohere')).toBe(false);
    expect(isLlmProvider('openai')).toBe(true);
    expect(isReasoningScale('exhaustive')).toBe(false);
    expect(isReasoningScale('balanced')).toBe(true);
  });
});
