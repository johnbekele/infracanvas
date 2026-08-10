// Model credentials: which provider and model to use, and the key to reach it.
//
// The key travels in on this route and never travels back out. Nothing here
// returns it, and the only thing stored alongside the ciphertext is its last
// four characters, which is enough for a user to recognise a key and useless to
// anyone who reads the response.
import { Router, type Request, type Response } from 'express';
import { getProvider, isLlmProvider } from '@infracanvas/core';
import { logError } from '../../lib/log.js';
import {
  deleteCredential,
  findCredential,
  getDecryptedKey,
  saveCredential,
  setDefaultCredential,
} from '../../lib/db/llm-credentials.js';
import { verifyCredential } from '../../lib/llm/verify.js';

const router = Router();

class InvalidCredentialError extends Error {}

interface CredentialBody {
  provider: unknown;
  model: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  makeDefault?: unknown;
}

function readCredential(body: CredentialBody) {
  if (!isLlmProvider(body.provider)) {
    throw new InvalidCredentialError('provider must be a supported model provider.');
  }

  if (typeof body.model !== 'string' || body.model.trim() === '') {
    throw new InvalidCredentialError('model is required.');
  }

  const provider = getProvider(body.provider);
  const apiKey = typeof body.apiKey === 'string' && body.apiKey !== '' ? body.apiKey : null;

  // Bedrock uses the process's AWS credentials and Ollama is a local service,
  // so requiring a key for either would mean asking the user to invent one.
  if (provider?.requiresApiKey && !apiKey) {
    throw new InvalidCredentialError(`${provider.name} needs an API key.`);
  }

  const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl !== '' ? body.baseUrl : null;

  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    throw new InvalidCredentialError('baseUrl must be an http or https URL.');
  }

  return {
    provider: body.provider,
    model: body.model.trim(),
    apiKey,
    baseUrl,
    makeDefault: body.makeDefault === true,
  };
}

/**
 * POST /settings/llm
 */
router.post('/', async (req: Request, res: Response) => {
  let input: ReturnType<typeof readCredential>;

  try {
    input = readCredential((req.body ?? {}) as CredentialBody);
  } catch (error) {
    if (error instanceof InvalidCredentialError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  try {
    const credential = await saveCredential({ userId: req.session!.userId, ...input });
    res.status(201).json({ credential });
  } catch (error) {
    // Deliberately not forwarding the message: a database error can quote the
    // statement, and the statement carries the ciphertext.
    logError('Failed to save an LLM credential', error);
    res.status(500).json({ error: 'Failed to save the credential' });
  }
});

/**
 * DELETE /settings/llm/:id
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await deleteCredential(req.session!.userId, req.params.id);

    // Absent rather than forbidden for a credential owned by someone else: a
    // 403 would confirm that the id exists.
    if (!deleted) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    res.status(204).end();
  } catch (error) {
    logError('Failed to delete an LLM credential', error);
    res.status(500).json({ error: 'Failed to delete the credential' });
  }
});

/**
 * POST /settings/llm/:id/default
 */
router.post('/:id/default', async (req: Request, res: Response) => {
  try {
    const credential = await setDefaultCredential(req.session!.userId, req.params.id);

    if (!credential) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    res.json({ credential });
  } catch (error) {
    logError('Failed to set the default LLM credential', error);
    res.status(500).json({ error: 'Failed to set the default credential' });
  }
});

/**
 * POST /settings/llm/:id/verify
 *
 * Uses the stored key, which is why this is a route and not something the
 * browser could do itself.
 */
router.post('/:id/verify', async (req: Request, res: Response) => {
  try {
    const credential = await findCredential(req.session!.userId, req.params.id);

    if (!credential) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }

    const apiKey = await getDecryptedKey(req.session!.userId, req.params.id);

    const result = await verifyCredential({
      provider: credential.provider,
      model: credential.model,
      apiKey,
      baseUrl: credential.baseUrl,
    });

    res.json(result);
  } catch (error) {
    logError('Failed to verify an LLM credential', error);
    res.status(500).json({ error: 'Failed to verify the credential' });
  }
});

export { readCredential, InvalidCredentialError };
export default router;
