// Analysis runs for a connected repository.
import { Router, type Request, type Response } from 'express';
import { proposeArchitecture } from '@infracanvas/core';
import { getGitHubToken } from '../../lib/db/tokens.js';
import { findRepository } from '../../lib/db/repositories.js';
import {
  AnalysisInProgressError,
  completeAnalysis,
  failAnalysis,
  findAnalysis,
  listAnalyses,
  startAnalysis,
} from '../../lib/db/analyses.js';
import { analyzeRepository } from '../../lib/analysis/analyze.js';
import { GitHubSourceError } from '../../lib/analysis/github-source.js';
import { assertBranch, InvalidGitHubParamError } from '../../lib/github-params.js';
import { logError } from '../../lib/log.js';

// `mergeParams` so `:repositoryId` from the parent router is visible here.
const router = Router({ mergeParams: true });

/**
 * POST /repositories/:repositoryId/analyses
 * Analyse the repository and return the finished run.
 *
 * Runs inline rather than on a queue. The profile is built from about a dozen
 * GitHub requests and no cloning, so it finishes in seconds, and a queue would
 * add a worker, a polling endpoint, and a class of stuck-job bugs for no gain
 * at this size. Deep ingestion does need a worker, and will bring one.
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

  const token = await getGitHubToken(userId);
  if (!token) {
    res.status(401).json({ error: 'GitHub token not found. Please reconnect.' });
    return;
  }

  let analysis;
  try {
    analysis = await startAnalysis(repository.id, ref);
  } catch (error) {
    if (error instanceof AnalysisInProgressError) {
      res.status(409).json({ error: error.message });
      return;
    }
    logError('Failed to start analysis', error);
    res.status(500).json({ error: 'Failed to start analysis' });
    return;
  }

  try {
    const profile = await analyzeRepository({
      token,
      owner: repository.githubOwner,
      repo: repository.githubName,
      ref,
    });

    // Synthesised here rather than in the browser. The proposal is the record of
    // what was decided about this commit -- each decision with its rationale and
    // the files it rests on -- and recomputing it on every page load threw that
    // record away as soon as the user navigated.
    const architecture = proposeArchitecture(profile, repository.githubName);

    res.status(201).json({ analysis: await completeAnalysis(analysis.id, profile, architecture) });
  } catch (error) {
    // Recorded as a failed run before responding. A run left in `running`
    // would hold the one-active-run index and block every later attempt.
    const message =
      error instanceof GitHubSourceError ? error.message : 'Analysis failed unexpectedly';

    if (!(error instanceof GitHubSourceError)) {
      logError('Analysis failed', error);
    }

    const failed = await failAnalysis(analysis.id, message);
    res.status(error instanceof GitHubSourceError ? 502 : 500).json({ analysis: failed });
  }
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
