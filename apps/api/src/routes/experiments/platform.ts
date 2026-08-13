import { defaultCredential, getDecryptedKey } from '../../lib/db/llm-credentials.js';
import {
  openAiCompatibleModel,
  supportsChat,
  type ChatModel,
} from '../../lib/copilot/chat-model.js';
import { PostgresCopilotStore } from '../../lib/copilot/postgres-store.js';
import { PostgresTranscriptStore } from '../../lib/copilot/postgres-transcript.js';
import { localPreviewPlane, type PreviewPlane } from '../../lib/copilot/preview-plane.js';
import type { CopilotStore } from '../../lib/copilot/store.js';
import type { TranscriptStore } from '../../lib/copilot/transcript.js';

/**
 * What the copilot routes are wired to.
 *
 * The two stores are the Postgres adapters of the ports in
 * `apps/api/src/lib/copilot/`: a proposal outlives the process that made it, and
 * a transcript that vanishes on restart is not a transcript. Swapping an adapter
 * remains a change to this module and nothing else, which is the point of having
 * it -- every route and every tool takes its store through an interface, and the
 * in-memory adapters beside them are what the unit tests run against.
 */

interface Platform {
  store: CopilotStore;
  transcript: TranscriptStore;
  preview: PreviewPlane;
}

let platform: Platform | null = null;

export function copilotPlatform(): Platform {
  platform ??= {
    store: new PostgresCopilotStore(),
    transcript: new PostgresTranscriptStore(),
    preview: localPreviewPlane(),
  };
  return platform;
}

/** Test seam, so a suite can install a store it seeded. */
export function setCopilotPlatform(next: Platform | null): void {
  platform = next;
}

/**
 * The user's own model, or nothing.
 *
 * Nothing here falls back to a shared key: the copilot spends the user's
 * credential, which is the arrangement #64 established, and a turn with no
 * credential is refused with an instruction rather than quietly billed to
 * somebody else.
 */
export async function chatModelFor(
  userId: string
): Promise<{ model: ChatModel; modelName: string } | null> {
  const credential = await defaultCredential(userId);
  if (credential === null || !supportsChat(credential.provider)) return null;

  const apiKey = await getDecryptedKey(userId, credential.id);
  return {
    model: openAiCompatibleModel({
      provider: credential.provider,
      model: credential.model,
      apiKey,
      baseUrl: credential.baseUrl ?? null,
    }),
    modelName: credential.model,
  };
}
