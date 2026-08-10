/**
 * The model providers a user can point this at.
 *
 * Bring-your-own-key, because the alternative is a shared account whose bill
 * and whose data-retention terms belong to whoever runs the instance. A self-
 * hosted deployment should be able to run entirely against a local Ollama and
 * never send a repository's contents anywhere.
 */
export type LlmProvider = 'openai' | 'anthropic' | 'bedrock' | 'google' | 'ollama';

export interface ProviderInfo {
  id: LlmProvider;
  name: string;
  /**
   * Whether an API key must be supplied.
   *
   * Bedrock authenticates with the AWS credentials the process already has, and
   * Ollama is a local process with no account behind it. Demanding a key for
   * either would mean inventing one.
   */
  requiresApiKey: boolean;
  /** Whether the endpoint is configurable, for proxies and self-hosted models. */
  supportsBaseUrl: boolean;
  /** Suggestions, not a whitelist: model names change faster than releases do. */
  suggestedModels: string[];
  defaultBaseUrl?: string;
}

export const llmProviders: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    supportsBaseUrl: true,
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    requiresApiKey: true,
    supportsBaseUrl: true,
    suggestedModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    requiresApiKey: false,
    supportsBaseUrl: false,
    suggestedModels: [
      'anthropic.claude-sonnet-4-5-v1:0',
      'anthropic.claude-haiku-4-5-v1:0',
      'meta.llama3-3-70b-instruct-v1:0',
    ],
  },
  {
    id: 'google',
    name: 'Google AI',
    requiresApiKey: true,
    supportsBaseUrl: false,
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    requiresApiKey: false,
    supportsBaseUrl: true,
    suggestedModels: ['llama3.3', 'qwen2.5-coder', 'deepseek-r1'],
    defaultBaseUrl: 'http://localhost:11434',
  },
];

export function getProvider(id: string): ProviderInfo | undefined {
  return llmProviders.find((provider) => provider.id === id);
}

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === 'string' && llmProviders.some((provider) => provider.id === value);
}
