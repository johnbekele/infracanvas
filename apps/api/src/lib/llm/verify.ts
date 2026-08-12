/**
 * Proving a credential works before anything depends on it.
 *
 * The cheapest call each provider offers, which is listing models rather than
 * generating anything: it costs nothing, and a wrong key, a wrong base URL and
 * an unreachable local server all fail differently enough to be worth telling
 * apart. Discovering a bad key halfway through an architecture proposal is a
 * much worse place to find out.
 */
import { getProvider, type LlmProvider } from '@infracanvas/core';

export interface VerifyInput {
  provider: LlmProvider;
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
}

export type VerifyResult = { ok: true; model: string } | { ok: false; error: string };

/** Long enough for a cold local model server, short enough not to hold a request. */
const TIMEOUT_MS = 10_000;

interface Probe {
  url: string;
  headers: Record<string, string>;
}

function probeFor(input: VerifyInput): Probe | null {
  const base = input.baseUrl?.replace(/\/$/, '');

  switch (input.provider) {
    case 'openai':
      return {
        url: `${base ?? 'https://api.openai.com'}/v1/models`,
        headers: { Authorization: `Bearer ${input.apiKey}` },
      };

    case 'anthropic':
      return {
        url: `${base ?? 'https://api.anthropic.com'}/v1/models`,
        headers: {
          'x-api-key': input.apiKey as string,
          'anthropic-version': '2023-06-01',
        },
      };

    case 'google':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(input.apiKey as string)}`,
        headers: {},
      };

    case 'ollama':
      return { url: `${base ?? 'http://localhost:11434'}/api/tags`, headers: {} };

    case 'bedrock':
      // Bedrock authenticates with the process's AWS credentials, which are a
      // separate connection with their own scopes. Claiming to have verified
      // them here would be a claim about something this code cannot see.
      return null;
  }
}

/**
 * Whether the credential can reach its provider.
 *
 * The failure message is written for the person who typed the key and never
 * contains it: an error string that echoes a request header is a credential in
 * a log file.
 */
export async function verifyCredential(input: VerifyInput): Promise<VerifyResult> {
  const provider = getProvider(input.provider);

  if (!provider) return { ok: false, error: `Unknown provider "${input.provider}".` };

  if (provider.requiresApiKey && !input.apiKey) {
    return { ok: false, error: `${provider.name} needs an API key.` };
  }

  const probe = probeFor(input);

  if (!probe) {
    return { ok: true, model: input.model };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(probe.url, {
      headers: probe.headers,
      signal: controller.signal,
    });

    if (response.ok) return { ok: true, model: input.model };

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: `${provider.name} rejected the API key.` };
    }

    // Deliberately not forwarding the body: a provider that echoes the request
    // back on an error would put the key in this message.
    return { ok: false, error: `${provider.name} returned ${response.status}.` };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: `${provider.name} did not respond within 10 seconds.` };
    }

    const causeMessage =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '';

    if (causeMessage.includes('issuer certificate')) {
      return {
        ok: false,
        error:
          `Could not verify the TLS connection to ${provider.name}. ` +
          'If you are behind a corporate proxy, set NODE_EXTRA_CA_CERTS to your root CA bundle.',
      };
    }

    return {
      ok: false,
      error: `Could not reach ${provider.name}. Check the base URL and that the service is running.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
