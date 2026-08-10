// A user's own configuration: region, currency, and how hard the model thinks.
import { Router, type Request, type Response } from 'express';
import { isReasoningScale } from '@infracanvas/core';
import { requireAuth } from '../../middleware/auth.js';
import { apiRateLimit } from '../../middleware/rate-limit.js';
import { logError } from '../../lib/log.js';
import { getSettings, updateSettings, type SettingsPatch } from '../../lib/db/settings.js';
import { listCredentials } from '../../lib/db/llm-credentials.js';
import llmRouter from './llm.js';

const router = Router();

router.use(apiRateLimit);
router.use(requireAuth);

router.use('/llm', llmRouter);

/** AWS region names are lowercase letters, digits and hyphens, and short. */
const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d$/;
const CURRENCIES = new Set(['USD', 'EUR', 'GBP']);

class InvalidSettingError extends Error {}

/**
 * Validate the patch rather than trusting it.
 *
 * Every field here ends up in a cost calculation or a provider request, so a
 * value the database would accept but nothing can use is worth refusing at the
 * edge where the user can still see why.
 */
function readPatch(body: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};

  if ('defaultRegion' in body) {
    const region = body.defaultRegion;
    if (typeof region !== 'string' || !REGION_PATTERN.test(region)) {
      throw new InvalidSettingError('defaultRegion must look like an AWS region name.');
    }
    patch.defaultRegion = region;
  }

  if ('currency' in body) {
    const currency = body.currency;
    if (typeof currency !== 'string' || !CURRENCIES.has(currency)) {
      throw new InvalidSettingError(`currency must be one of ${[...CURRENCIES].join(', ')}.`);
    }
    patch.currency = currency;
  }

  if ('reasoningScale' in body) {
    if (!isReasoningScale(body.reasoningScale)) {
      throw new InvalidSettingError('reasoningScale must be "fast", "balanced" or "thorough".');
    }
    patch.reasoningScale = body.reasoningScale;
  }

  if ('monthlyTokenBudget' in body) {
    const budget = body.monthlyTokenBudget;
    // Null is meaningful: it clears the budget rather than leaving it alone.
    if (
      budget !== null &&
      (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0)
    ) {
      throw new InvalidSettingError('monthlyTokenBudget must be a positive whole number, or null.');
    }
    patch.monthlyTokenBudget = budget;
  }

  return patch;
}

/**
 * GET /settings
 * Settings and configured model credentials. Keys are never included.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const [settings, credentials] = await Promise.all([
      getSettings(req.session!.userId),
      listCredentials(req.session!.userId),
    ]);

    res.json({ settings, credentials });
  } catch (error) {
    logError('Failed to load settings', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

/**
 * PATCH /settings
 */
router.patch('/', async (req: Request, res: Response) => {
  let patch: SettingsPatch;

  try {
    patch = readPatch((req.body ?? {}) as Record<string, unknown>);
  } catch (error) {
    if (error instanceof InvalidSettingError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  try {
    const settings = await updateSettings(req.session!.userId, patch);
    res.json({ settings });
  } catch (error) {
    logError('Failed to update settings', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export { readPatch, InvalidSettingError };
export default router;
