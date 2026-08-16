// The append-only revision chain of one experiment, over HTTP.
import { Router, type Request, type Response } from 'express';
import { validateIr } from '@infracanvas/ir-schema';
import {
  appendRevision,
  findRevision,
  listRevisions,
  PatchMismatchError,
  RevisionConflictError,
  type IrRevisionSource,
} from '../../lib/db/experiment-revisions.js';
import { logError } from '../../lib/log.js';
import { requireExperiment } from './require-experiment.js';
import type {
  CreateRevisionBody,
  IrRejectedResponse,
  ListRevisionsResponse,
  RevisionConflictResponse,
  RevisionResponse,
} from './types.js';

// `mergeParams` so `:experimentId` from the parent router is visible here.
const router = Router({ mergeParams: true });

const SOURCES: readonly IrRevisionSource[] = [
  'proposal',
  'canvas_edit',
  'copilot_patch',
  'fork',
  'import',
  'revert',
];

/** The longest history the timeline asks for in one request. */
const MAX_LIMIT = 200;

function isSource(value: unknown): value is IrRevisionSource {
  return typeof value === 'string' && SOURCES.includes(value as IrRevisionSource);
}

/**
 * GET /experiments/:experimentId/revisions
 * The timeline, newest first, without the documents.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const experiment = await requireExperiment(req, res);
    if (!experiment) return;

    const revisions = await listRevisions(req.session!.userId, experiment.id, MAX_LIMIT);
    const body: ListRevisionsResponse = { revisions };
    res.json(body);
  } catch (error) {
    logError('Failed to list revisions', error);
    res.status(500).json({ error: 'Failed to list revisions' });
  }
});

/**
 * GET /experiments/:experimentId/revisions/:revisionId
 * One revision, with its document.
 */
router.get('/:revisionId', async (req: Request, res: Response) => {
  try {
    const experiment = await requireExperiment(req, res);
    if (!experiment) return;

    const revision = await findRevision(req.session!.userId, experiment.id, req.params.revisionId);

    if (!revision) {
      res.status(404).json({ error: 'Revision not found' });
      return;
    }

    const body: RevisionResponse = { revision };
    res.json(body);
  } catch (error) {
    logError('Failed to fetch revision', error);
    res.status(500).json({ error: 'Failed to fetch revision' });
  }
});

/**
 * POST /experiments/:experimentId/revisions
 * Append one revision to the chain.
 *
 * The author is the session rather than the body. A client that could name its
 * own `authorKind` could attribute its edit to the copilot, or a copilot
 * suggestion to the user who was shown it, and the timeline would be a record of
 * whatever the last caller claimed. `source` is the body's to give, because only
 * the client knows whether a document came off the canvas or out of a patch.
 */
router.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<CreateRevisionBody>;

  try {
    const experiment = await requireExperiment(req, res);
    if (!experiment) return;

    if (typeof body.parentId !== 'string') {
      res.status(400).json({ error: 'parentId is required and must name the current head' });
      return;
    }
    if (typeof body.summary !== 'string' || body.summary.length < 1 || body.summary.length > 200) {
      res.status(400).json({ error: 'summary is required and must be 1 to 200 characters' });
      return;
    }
    if (!isSource(body.source)) {
      res.status(400).json({ error: `source must be one of ${SOURCES.join(', ')}` });
      return;
    }
    if (body.patch !== undefined && !Array.isArray(body.patch)) {
      res.status(400).json({ error: 'patch must be an array of RFC 6902 operations' });
      return;
    }

    // Validated before the document reaches the database, and reported with the
    // pointers that failed: a revision holding a document the validator rejects
    // is a revision nobody can price, and "invalid architecture" alone is not
    // something the canvas can highlight.
    const validated = validateIr(body.ir);
    if (!validated.valid) {
      const rejected: IrRejectedResponse = {
        error: 'The architecture does not validate against the IR schema',
        problems: validated.problems,
      };
      res.status(400).json(rejected);
      return;
    }

    const revision = await appendRevision(req.session!.userId, {
      experimentId: experiment.id,
      parentId: body.parentId,
      ir: validated.document,
      irVersion: validated.document.irVersion,
      patch: body.patch,
      summary: body.summary,
      source: body.source,
      // A human accepting a copilot patch is a human-authored `copilot_patch`,
      // which is why this is derived from the session and not from `source`.
      authorKind: 'human',
      authorUserId: req.session!.userId,
    });

    const created: RevisionResponse = { revision };
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      // The new head travels with the refusal so the page can offer to rebase or
      // discard without another request.
      const conflict: RevisionConflictResponse = {
        error: error.message,
        headRevisionId: error.headRevisionId,
        headSeq: error.headSeq,
      };
      res.status(409).json(conflict);
      return;
    }
    if (error instanceof PatchMismatchError) {
      res.status(400).json({ error: error.message });
      return;
    }
    logError('Failed to append revision', error);
    res.status(500).json({ error: 'Failed to append revision' });
  }
});

export default router;
