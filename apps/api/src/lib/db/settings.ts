// A user's preferences, with defaults that exist whether or not a row does.
import { query } from './client.js';
import type { ReasoningScale } from '@infracanvas/core';

export interface UserSettings {
  defaultRegion: string;
  currency: string;
  reasoningScale: ReasoningScale;
  monthlyTokenBudget: number | null;
}

interface SettingsRow {
  default_region: string;
  currency: string;
  reasoning_scale: ReasoningScale;
  monthly_token_budget: number | null;
}

/**
 * What a user gets before they have chosen anything.
 *
 * Stated here as well as in the table default so that reading settings never
 * depends on a row existing: a user who has not opened the page and one who
 * opened it and changed nothing behave identically.
 */
export const DEFAULT_SETTINGS: UserSettings = {
  defaultRegion: 'us-east-1', // infracanvas-allow: no-hardcoded-region -- this is the setting
  currency: 'USD',
  reasoningScale: 'balanced',
  monthlyTokenBudget: null,
};

function toSettings(row: SettingsRow): UserSettings {
  return {
    defaultRegion: row.default_region,
    currency: row.currency,
    reasoningScale: row.reasoning_scale,
    monthlyTokenBudget: row.monthly_token_budget,
  };
}

export async function getSettings(userId: string): Promise<UserSettings> {
  const result = await query<SettingsRow>(`SELECT * FROM user_settings WHERE user_id = $1`, [
    userId,
  ]);

  return result.rows[0] ? toSettings(result.rows[0]) : DEFAULT_SETTINGS;
}

export type SettingsPatch = Partial<UserSettings>;

/**
 * Apply a partial update, creating the row if this is the first one.
 *
 * A single upsert rather than a read, merge and write: two browser tabs saving
 * different fields should both take effect, and COALESCE on the excluded values
 * is what makes an absent field mean "leave it alone" rather than "clear it".
 */
export async function updateSettings(userId: string, patch: SettingsPatch): Promise<UserSettings> {
  const result = await query<SettingsRow>(
    `INSERT INTO user_settings (user_id, default_region, currency, reasoning_scale, monthly_token_budget)
     VALUES ($1, COALESCE($2, $7), COALESCE($3, $8), COALESCE($4, $9), $5)
     ON CONFLICT (user_id) DO UPDATE
       SET default_region       = COALESCE($2, user_settings.default_region),
           currency             = COALESCE($3, user_settings.currency),
           reasoning_scale      = COALESCE($4, user_settings.reasoning_scale),
           -- The budget is nullable, so "not supplied" and "cleared" cannot be
           -- told apart by the value alone; the flag carries the difference.
           monthly_token_budget = CASE WHEN $6 THEN $5 ELSE user_settings.monthly_token_budget END
     RETURNING *`,
    [
      userId,
      patch.defaultRegion ?? null,
      patch.currency ?? null,
      patch.reasoningScale ?? null,
      patch.monthlyTokenBudget ?? null,
      'monthlyTokenBudget' in patch,
      DEFAULT_SETTINGS.defaultRegion,
      DEFAULT_SETTINGS.currency,
      DEFAULT_SETTINGS.reasoningScale,
    ]
  );

  return toSettings(result.rows[0]);
}
