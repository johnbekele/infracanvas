// Settings and model credentials.
//
// A credential type with no field for the key, mirroring the server: the value
// is not omitted from responses by convention, it has nowhere to go.
import type { LlmProvider, ReasoningScale } from '@infracanvas/core';
import { apiFetch } from './client';

export interface UserSettings {
  defaultRegion: string;
  currency: string;
  reasoningScale: ReasoningScale;
  monthlyTokenBudget: number | null;
}

export interface LlmCredential {
  id: string;
  provider: LlmProvider;
  model: string;
  /** Last four characters of the stored key, or null when there is none. */
  keyHint: string | null;
  baseUrl: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface SettingsResponse {
  settings: UserSettings;
  credentials: LlmCredential[];
}

export interface NewCredential {
  provider: LlmProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  makeDefault?: boolean;
}

export const settingsApi = {
  async get(): Promise<SettingsResponse> {
    return apiFetch('/settings');
  },

  async update(patch: Partial<UserSettings>): Promise<{ settings: UserSettings }> {
    return apiFetch('/settings', { method: 'PATCH', body: JSON.stringify(patch) });
  },

  async addCredential(input: NewCredential): Promise<{ credential: LlmCredential }> {
    return apiFetch('/settings/llm', { method: 'POST', body: JSON.stringify(input) });
  },

  async deleteCredential(id: string): Promise<void> {
    await apiFetch(`/settings/llm/${id}`, { method: 'DELETE' });
  },

  async makeDefault(id: string): Promise<{ credential: LlmCredential }> {
    return apiFetch(`/settings/llm/${id}/default`, { method: 'POST' });
  },

  /** Uses the stored key, which is why the browser cannot do this itself. */
  async verify(id: string): Promise<{ ok: boolean; model?: string; error?: string }> {
    return apiFetch(`/settings/llm/${id}/verify`, { method: 'POST' });
  },
};
