// Experiments: the hypothesis, its architecture, and its history.
import { Router, type Request, type Response } from 'express';
import { validateIr } from '@infracanvas/ir-schema';
import { requireAuth } from '../../middleware/auth.js';
import { apiRateLimit } from '../../middleware/rate-limit.js';
import { env } from '../../lib/env.js';
import { logError } from '../../lib/log.js';
import { findRepository } from '../../lib/db/repositories.js';
import {
  deleteExperiment,
  listExperiments,
  recordVerdict,
  renameExperiment,
  setExperimentArchived,
  type Experiment,
  type ExperimentVerdict,
} from '../../lib/db/experiments.js';
import { findRevision, headRevision } from '../../lib/db/experiment-revisions.js';
import { createExperimentWithRevision, forkExperiment } from '../../lib/experiments/fork.js';
import {
  NoAnalysisError,
  SeedConversionError,
  seedFromLatestAnalysis,
} from '../../lib/experiments/seed.js';
import revisionsRouter from './revisions.js';
import { requireExperiment } from './require-experiment.js';
import type {
  CreateExperimentBody,
  ExperimentResponse,
  ForkExperimentBody,
  IrRejectedResponse,
  ListExperimentsResponse,
  PatchExperimentBody,
} from './types.js';

const router = Router();

router.use(apiRateLimit);
router.use(requireAuth);

router.use('/:experimentId/revisions', revisionsRouter);

const VERDICTS: readonly ExperimentVerdict[] = ['undecided', 'adopt', 'reject', 'inconclusive'];

const MAX_NAME = 200;
const MAX_HYPOTHESIS = 500;
const MAX_VERDICT_NOTE = 2000;

/** Hours the guardrails accept, so a typo cannot create a month-long experiment. */
const MAX_TTL_HOURS = 24 * 14;
const MAX_BUDGET_USD = 100_000;

function isVerdict(value: unknown): value is ExperimentVerdict {
  return typeof value === 'string' && VERDICTS.includes(value as ExperimentVerdict);
}

/** A trimmed, length-checked string, or null when the value is not usable. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

interface Guardrails {
  expiresAt: Date;
  budgetUsd: number;
}

/**
 * The TTL and the budget for a new experiment.
 *
 * Both are written onto the row rather than read at sweep time, so the value in
 * force when an experiment was created is the value it keeps. A request may lower
 * or raise them within bounds; the bounds exist because these are the only things
 * standing between a mistyped number and an AWS bill.
 */
function guardrails(body: { ttlHours?: unknown; budgetUsd?: unknown }): Guardrails | string {
  const config = env();

  let hours = config.EXPERIMENT_DEFAULT_TTL_HOURS;
  if (body.ttlHours !== undefined) {
    if (typeof body.ttlHours !== 'number' || !Number.isFinite(body.ttlHours)) {
      return 'ttlHours must be a number';
    }
    if (body.ttlHours <= 0 || body.ttlHours > MAX_TTL_HOURS) {
      return `ttlHours must be between 0 and ${MAX_TTL_HOURS}`;
    }
    hours = body.ttlHours;
  }

  let budgetUsd = config.EXPERIMENT_DEFAULT_BUDGET_USD;
  if (body.budgetUsd !== undefined) {
    if (typeof body.budgetUsd !== 'number' || !Number.isFinite(body.budgetUsd)) {
      return 'budgetUsd must be a number';
    }
    if (body.budgetUsd <= 0 || body.budgetUsd > MAX_BUDGET_USD) {
      return `budgetUsd must be between 0 and ${MAX_BUDGET_USD}`;
    }
    budgetUsd = body.budgetUsd;
  }

  return { expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000), budgetUsd };
}

/** An experiment with its head revision, which is what the workspace page reads. */
async function withHead(userId: string, experiment: Experiment): Promise<ExperimentResponse> {
  return { experiment, head: await headRevision(userId, experiment.id) };
}

/**
 * GET /experiments
 * The caller's experiments, newest first. Archived ones are hidden by default.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const repositoryId =
      typeof req.query.repositoryId === 'string' ? req.query.repositoryId : undefined;

    const experiments = await listExperiments(req.session!.userId, {
      repositoryId,
      includeArchived: req.query.includeArchived === 'true',
    });

    const body: ListExperimentsResponse = { experiments };
    res.json(body);
  } catch (error) {
    logError('Failed to list experiments', error);
    res.status(500).json({ error: 'Failed to list experiments' });
  }
});

/**
 * POST /experiments
 * Create an experiment, seeding revision 1.
 *
 * Either from the newest succeeded analysis of a repository the caller has
 * connected, or from a document the caller supplies. The row and its first
 * revision commit together, so no client sees an experiment with no architecture.
 */
router.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<CreateExperimentBody>;

  try {
    const name = text(body.name, MAX_NAME);
    if (!name) {
      res.status(400).json({ error: `name is required and must be 1 to ${MAX_NAME} characters` });
      return;
    }

    // Required, not optional: an experiment with no hypothesis is a drawing, and
    // the comparison view has nothing to title its two columns with.
    const hypothesis = text(body.hypothesis, MAX_HYPOTHESIS);
    if (!hypothesis) {
      res
        .status(400)
        .json({ error: `hypothesis is required and must be 1 to ${MAX_HYPOTHESIS} characters` });
      return;
    }

    const limits = guardrails(body);
    if (typeof limits === 'string') {
      res.status(400).json({ error: limits });
      return;
    }

    if (body.repositoryId === undefined && body.ir === undefined) {
      res.status(400).json({ error: 'Either repositoryId or ir is required' });
      return;
    }

    let repositoryId: string | null = null;
    if (body.repositoryId !== undefined) {
      const repository = await findRepository(req.session!.userId, body.repositoryId);
      if (!repository) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      repositoryId = repository.id;

      // An explicit document wins over seeding, so a caller holding an
      // architecture already does not have to have an analysis to start from.
      if (body.ir === undefined) {
        const seeded = await seedFromLatestAnalysis(repository, env().AWS_REGION);
        const created = await createExperimentWithRevision({
          userId: req.session!.userId,
          repositoryId,
          name,
          hypothesis,
          ir: seeded.ir,
          irVersion: seeded.ir.irVersion,
          summary: 'Proposed from the repository analysis',
          source: 'proposal',
          ...limits,
        });

        const seededResponse: ExperimentResponse = {
          experiment: created.experiment,
          head: created.revision,
          gaps: seeded.gaps,
        };
        res.status(201).json(seededResponse);
        return;
      }
    }

    const validated = validateIr(body.ir);
    if (!validated.valid) {
      const rejected: IrRejectedResponse = {
        error: 'The architecture does not validate against the IR schema',
        problems: validated.problems,
      };
      res.status(400).json(rejected);
      return;
    }

    const created = await createExperimentWithRevision({
      userId: req.session!.userId,
      repositoryId,
      name,
      hypothesis,
      ir: validated.document,
      irVersion: validated.document.irVersion,
      summary: 'Imported with the experiment',
      source: 'import',
      ...limits,
    });

    const response: ExperimentResponse = {
      experiment: created.experiment,
      head: created.revision,
    };
    res.status(201).json(response);
  } catch (error) {
    if (error instanceof NoAnalysisError) {
      // 409 rather than 400: the request is well formed, the repository is simply
      // not in a state that can seed an architecture yet.
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof SeedConversionError) {
      logError('Seeding produced an architecture the IR cannot hold', error);
      res.status(500).json({ error: error.message, problems: error.problems });
      return;
    }
    logError('Failed to create experiment', error);
    res.status(500).json({ error: 'Failed to create experiment' });
  }
});

/**
 * GET /experiments/:experimentId
 * The experiment and its head revision, so the page can draw in one request.
 */
router.get('/:experimentId', async (req: Request, res: Response) => {
  try {
    const experiment = await requireExperiment(req, res);
    if (!experiment) return;

    res.json(await withHead(req.session!.userId, experiment));
  } catch (error) {
    logError('Failed to fetch experiment', error);
    res.status(500).json({ error: 'Failed to fetch experiment' });
  }
});

/**
 * PATCH /experiments/:experimentId
 * Rename, restate the hypothesis, record a verdict, or archive.
 *
 * Touches nothing about the architecture: an edit to the document is an append to
 * the revision chain, which is a different request with different semantics.
 */
router.patch('/:experimentId', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<PatchExperimentBody>;

  try {
    const experiment = await requireExperiment(req, res);
    if (!experiment) return;

    const fields: { name?: string; hypothesis?: string } = {};

    if (body.name !== undefined) {
      const name = text(body.name, MAX_NAME);
      if (!name) {
        res.status(400).json({ error: `name must be 1 to ${MAX_NAME} characters` });
        return;
      }
      fields.name = name;
    }

    if (body.hypothesis !== undefined) {
      const hypothesis = text(body.hypothesis, MAX_HYPOTHESIS);
      if (!hypothesis) {
        res.status(400).json({ error: `hypothesis must be 1 to ${MAX_HYPOTHESIS} characters` });
        return;
      }
      fields.hypothesis = hypothesis;
    }

    if (body.verdict !== undefined && !isVerdict(body.verdict)) {
      res.status(400).json({ error: `verdict must be one of ${VERDICTS.join(', ')}` });
      return;
    }

    // Refused here rather than left to the CHECK, so the caller gets a reason
    // instead of a constraint name: a verdict with no note is a badge rather than
    // a result, and six months later nobody can tell what "reject" meant.
    if (body.verdict !== undefined && body.verdict !== 'undecided') {
      const note = text(body.verdictNote, MAX_VERDICT_NOTE);
      if (!note) {
        res.status(400).json({ error: 'verdictNote is required for a decided verdict' });
        return;
      }
    }

    let updated = experiment;

    if (fields.name !== undefined || fields.hypothesis !== undefined) {
      const renamed = await renameExperiment(req.session!.userId, experiment.id, fields);
      if (!renamed) {
        res.status(404).json({ error: 'Experiment not found' });
        return;
      }
      updated = renamed;
    }

    if (body.verdict !== undefined) {
      const decided = await recordVerdict(
        req.session!.userId,
        experiment.id,
        body.verdict,
        text(body.verdictNote, MAX_VERDICT_NOTE) ?? ''
      );
      if (!decided) {
        res.status(404).json({ error: 'Experiment not found' });
        return;
      }
      updated = decided;
    }

    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') {
        res.status(400).json({ error: 'archived must be a boolean' });
        return;
      }
      const archived = await setExperimentArchived(
        req.session!.userId,
        experiment.id,
        body.archived
      );
      if (!archived) {
        res.status(404).json({ error: 'Experiment not found' });
        return;
      }
      updated = archived;
    }

    res.json(await withHead(req.session!.userId, updated));
  } catch (error) {
    logError('Failed to update experiment', error);
    res.status(500).json({ error: 'Failed to update experiment' });
  }
});

/**
 * POST /experiments/:experimentId/fork
 * Copy a revision into a new experiment with its own history.
 */
router.post('/:experimentId/fork', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<ForkExperimentBody>;

  try {
    const source = await requireExperiment(req, res);
    if (!source) return;

    const name = text(body.name, MAX_NAME);
    if (!name) {
      res.status(400).json({ error: `name is required and must be 1 to ${MAX_NAME} characters` });
      return;
    }

    const hypothesis = text(body.hypothesis, MAX_HYPOTHESIS);
    if (!hypothesis) {
      res
        .status(400)
        .json({ error: `hypothesis is required and must be 1 to ${MAX_HYPOTHESIS} characters` });
      return;
    }

    const limits = guardrails(body);
    if (typeof limits === 'string') {
      res.status(400).json({ error: limits });
      return;
    }

    // Defaults to the head, which is what "fork this experiment" means when no
    // revision is named. A named revision is looked up through the experiment, so
    // a revision id from elsewhere cannot be forked into the caller's account.
    const sourceRevision = body.revisionId
      ? await findRevision(req.session!.userId, source.id, body.revisionId)
      : await headRevision(req.session!.userId, source.id);

    if (!sourceRevision) {
      res.status(404).json({ error: 'Revision not found' });
      return;
    }

    const created = await forkExperiment({
      userId: req.session!.userId,
      source,
      sourceRevision,
      name,
      hypothesis,
      ...limits,
    });

    const response: ExperimentResponse = {
      experiment: created.experiment,
      head: created.revision,
    };
    res.status(201).json(response);
  } catch (error) {
    logError('Failed to fork experiment', error);
    res.status(500).json({ error: 'Failed to fork experiment' });
  }
});

/**
 * DELETE /experiments/:experimentId
 * Remove the experiment and its history.
 */
router.delete('/:experimentId', async (req: Request, res: Response) => {
  try {
    const removed = await deleteExperiment(req.session!.userId, req.params.experimentId);

    if (!removed) {
      res.status(404).json({ error: 'Experiment not found' });
      return;
    }

    res.status(204).end();
  } catch (error) {
    logError('Failed to delete experiment', error);
    res.status(500).json({ error: 'Failed to delete experiment' });
  }
});

export default router;
