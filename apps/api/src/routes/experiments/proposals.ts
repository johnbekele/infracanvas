import { Router, type Request, type Response } from 'express';

import { copilotDeps } from '../../lib/copilot/deps.js';
import { ExperimentNotFoundError } from '../../lib/copilot/errors.js';
import { applyPatch } from '../../lib/copilot/tools.js';
import { logError } from '../../lib/log.js';
import { copilotPlatform } from './platform.js';

/**
 * The user's answer to a diff card.
 *
 * Accepting is two steps in one route: mark the proposal accepted, then apply
 * it through the same `apply_patch` the copilot would call. Splitting it that
 * way makes the click idempotent - if the apply fails the proposal stays
 * accepted and pressing accept again completes it - and keeps one definition of
 * what applying means. Two writers of the architecture is exactly the
 * duplication that ends with two subtly different answers to "what did that
 * change do".
 */

const router: Router = Router({ mergeParams: true });

function scopeOf(req: Request): { experimentId: string; userId: string } {
  return { experimentId: req.params.experimentId, userId: req.session?.userId ?? '' };
}

router.post('/:proposalId/accept', async (req: Request, res: Response) => {
  const { store, preview } = copilotPlatform();
  const scope = scopeOf(req);

  try {
    await store.experiment(scope);
    const proposal = await store.proposal(scope, req.params.proposalId);
    if (proposal === null) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (proposal.status === 'proposed') await store.decide(scope, proposal.id, 'accepted');

    const outcome = await applyPatch(copilotDeps(scope, store, preview), {
      proposal_id: proposal.id,
    });

    if (outcome.outcome === 'stale') {
      res.status(409).json({ code: 'stale', message: outcome.message });
      return;
    }
    if (outcome.outcome === 'rejected_by_user') {
      res.status(409).json({ code: 'rejected', message: outcome.message });
      return;
    }

    const experiment = await store.experiment(scope);
    res.json({
      outcome: outcome.outcome,
      ir: experiment.ir,
      irDigest: experiment.irDigest,
      touchedNodeIds: outcome.touched_node_ids,
    });
  } catch (error) {
    if (error instanceof ExperimentNotFoundError) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    logError('Accepting a copilot proposal failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:proposalId/reject', async (req: Request, res: Response) => {
  const { store } = copilotPlatform();
  const scope = scopeOf(req);

  try {
    await store.experiment(scope);
    const rejected = await store.decide(scope, req.params.proposalId, 'rejected');
    if (rejected === null) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ status: rejected.status });
  } catch (error) {
    if (error instanceof ExperimentNotFoundError) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    logError('Rejecting a copilot proposal failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
