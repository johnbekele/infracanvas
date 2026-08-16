import { getProvider, type LlmProvider } from '@infracanvas/core';

/**
 * The model call, as the narrowest port a turn needs.
 *
 * `apps/api/src/lib/llm/` proves a BYOK credential works; nothing there holds a
 * conversation. Rather than adding a second provider abstraction, this is one
 * interface with one adapter over the OpenAI chat-completions wire format,
 * which OpenAI and Ollama both speak, and which the other providers can be
 * added to one adapter at a time.
 *
 * It is a port first and an adapter second for a reason the tests depend on:
 * every turn in the suite is played by a scripted model, because a copilot that
 * can only be tested against a live provider is a copilot nobody will change.
 */

export interface ChatToolSpec {
  name: string;
  description: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on a tool message, naming the call it answers. */
  toolCallId?: string;
  /** Set on an assistant message that asked for tools. */
  toolCalls?: { callId: string; name: string; arguments: string }[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ChatToolSpec[];
}

export type ChatChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; callId: string; name: string; arguments: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

export interface ChatModel {
  stream(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
}

export interface ChatCredential {
  provider: LlmProvider;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}

interface StreamDelta {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function endpoint(credential: ChatCredential): string {
  const base = credential.baseUrl?.replace(/\/$/, '');
  if (credential.provider === 'ollama')
    return `${base ?? 'http://localhost:11434'}/v1/chat/completions`;
  return `${base ?? 'https://api.openai.com'}/v1/chat/completions`;
}

/** Providers this adapter speaks for. The rest are refused before a turn opens. */
export function supportsChat(provider: LlmProvider): boolean {
  return getProvider(provider) !== undefined && (provider === 'openai' || provider === 'ollama');
}

/**
 * Server-sent chunks from an OpenAI-compatible endpoint.
 *
 * Tool calls arrive in fragments keyed by index, so they are assembled here and
 * emitted whole: a caller that has to reassemble a JSON argument string across
 * chunks is a caller that will parse a truncated one.
 */
export function openAiCompatibleModel(credential: ChatCredential): ChatModel {
  return {
    async *stream(request, signal) {
      const response = await fetch(endpoint(credential), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(credential.apiKey === null ? {} : { Authorization: `Bearer ${credential.apiKey}` }),
        },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
            ...(message.toolCalls === undefined
              ? {}
              : {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.callId,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                  })),
                }),
          })),
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: { type: 'object', additionalProperties: true },
            },
          })),
        }),
      });

      if (!response.ok || response.body === null) {
        // The status, never the body: a provider error body can carry the
        // request it rejected, and that request carries the architecture.
        throw new Error(`The model provider refused the request (${response.status}).`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const pending = new Map<number, { callId: string; name: string; arguments: string }>();
      let buffered = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });

        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;

          let delta: StreamDelta;
          try {
            delta = JSON.parse(payload) as StreamDelta;
          } catch {
            continue;
          }

          const choice = delta.choices?.[0]?.delta;
          if (choice?.content != null && choice.content !== '') {
            yield { kind: 'text', text: choice.content };
          }
          for (const call of choice?.tool_calls ?? []) {
            const existing = pending.get(call.index) ?? { callId: '', name: '', arguments: '' };
            pending.set(call.index, {
              callId: call.id ?? existing.callId,
              name: call.function?.name ?? existing.name,
              arguments: existing.arguments + (call.function?.arguments ?? ''),
            });
          }
          if (delta.usage !== undefined) {
            yield {
              kind: 'usage',
              inputTokens: delta.usage.prompt_tokens ?? 0,
              outputTokens: delta.usage.completion_tokens ?? 0,
            };
          }
        }
      }

      for (const call of pending.values()) {
        yield {
          kind: 'tool_call',
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        };
      }
    },
  };
}
