// Analysis runs for a connected repository.
import { Router, type Request, type Response } from 'express';
import { getGitHubToken } from '../../lib/db/tokens.js';
import { findRepository } from '../../lib/db/repositories.js';
import {
  AnalysisInProgressError,
  failAnalysis,
  findAnalysis,
  listAnalyses,
  queueAnalysis,
} from '../../lib/db/analyses.js';
import { enqueue } from '../../lib/jobs/queue.js';
import { ANALYZE_REPOSITORY } from '../../lib/jobs/handlers/analyze-repository.js';
import { streamAnalysisProgress } from '../../lib/jobs/progress-stream.js';
import { assertBranch, InvalidGitHubParamError } from '../../lib/github-params.js';
import { logError } from '../../lib/log.js';

// `mergeParams` so `:repositoryId` from the parent router is visible here.
const router = Router({ mergeParams: true });

/**
 * POST /repositories/:repositoryId/analyses
 * Queue an analysis and return the run that will carry its result.
 *
 * 202 rather than 201: nothing has been analysed yet. The work used to run
 * inside this request, which was fine for a small repository and a race against
 * the proxy's timeout for a large one -- and losing that race left the run stuck
 * in flight, holding the one-active-run index against every later attempt.
 * Failure on the queue is recorded on the row instead, so the user is told what
 * happened rather than left with a request that ended.
 */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.session!.userId;
  const { repositoryId } = req.params;

  const repository = await findRepository(userId, repositoryId);

  if (!repository) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  let ref: string;
  try {
    // Defaults to the branch recorded when the repository was connected.
    ref = assertBranch(req.body?.ref ?? repository.defaultBranch);
  } catch (error) {
    if (error instanceof InvalidGitHubParamError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  // Checked before queueing, even though the worker looks the token up again
  // when it runs. A user who has not connected GitHub should be told so now,
  // rather than by a job that fails a second later for a reason they have to go
  // and find.
  const token = await getGitHubToken(userId);
  if (!token) {
    res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
    return;
  }

  let analysis;
  try {
    analysis = await queueAnalysis(repository.id, ref);
  } catch (error) {
    if (error instanceof AnalysisInProgressError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logError('Failed to queue analysis', error);
    res.status(500).json({ error: 'Failed to queue analysis' });
    return;
  }

  try {
    const job = await enqueue({
      kind: ANALYZE_REPOSITORY,
      analysisId: analysis.id,
      payload: { analysisId: analysis.id, repositoryId: repository.id, userId, ref },
    });

    res.status(202).json({ analysis, jobId: job.id });
  } catch (error) {
    // The run exists but nothing will ever pick it up. Left pending it would
    // block every later attempt on the one-active-run index, so it is failed
    // here rather than becoming a repository nobody can analyse again.
    logError('Failed to enqueue analysis job', error);
    const failed = await failAnalysis(analysis.id, 'Could not be queued. Please try again.');
    res.status(500).json({ analysis: failed });
  }
});

/**
 * GET /repositories/:repositoryId/analyses/:analysisId/events
 * Progress for a run, as server-sent events.
 *
 * SSE rather than polling or a WebSocket: the traffic is one-way and bursty, an
 * EventSource reconnects on its own, and `Last-Event-ID` makes that reconnect
 * resume rather than replay. A WebSocket would add a second protocol to operate
 * for a stream that never carries a client message.
 *
 * Events are read from the job's log rather than pushed from the worker, so the
 * API process serving the stream does not have to be the one running the job.
 */
router.get('/:analysisId/events', async (req: Request, res: Response) => {
  const repository = await findRepository(req.session!.userId, req.params.repositoryId);

  if (!repository) {
    res.status(404).json({ error: 'Repository not found' });
    return;
  }

  const analysis = await findAnalysis(req.params.analysisId);
  if (!analysis || analysis.repositoryId !== repository.id) {
    res.status(404).json({ error: 'Analysis not found' });
    return;
  }

  await streamAnalysisProgress(req, res, analysis.id);
});

/**
 * GET /repositories/:repositoryId/analyses
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const repository = await findRepository(req.session!.userId, req.params.repositoryId);

    if (!repository) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    res.json({ analyses: await listAnalyses(repository.id) });
  } catch (error) {
    logError('Failed to list analyses', error);
    res.status(500).json({ error: 'Failed to list analyses' });
  }
});

/**
 * GET /repositories/:repositoryId/analyses/:analysisId
 */
router.get('/:analysisId', async (req: Request, res: Response) => {
  try {
    const repository = await findRepository(req.session!.userId, req.params.repositoryId);

    if (!repository) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    const analysis = await findAnalysis(req.params.analysisId);

    // Checked against the repository that was just proven to belong to the
    // caller, so an analysis id alone does not reach another account's profile.
    if (!analysis || analysis.repositoryId !== repository.id) {
      res.status(404).json({ error: 'Analysis not found' });
      return;
    }

    res.json({ analysis });
  } catch (error) {
    logError('Failed to fetch analysis', error);
    res.status(500).json({ error: 'Failed to fetch analysis' });
  }
});

export default router;
