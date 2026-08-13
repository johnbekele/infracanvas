// The ownership check every experiment route starts with.
import type { Request, Response } from 'express';
import { findExperiment, type Experiment } from '../../lib/db/experiments.js';

/**
 * The experiment named in the URL, or null after answering 404.
 *
 * One helper rather than a check written out in each handler, so no route can be
 * added without it. The answer for someone else's experiment is 404 rather than
 * 403: telling a caller that an id exists but is not theirs turns a uuid guess
 * into an oracle for who is testing what.
 */
export async function requireExperiment(
  req: Request,
  res: Response,
  experimentId = req.params.experimentId
): Promise<Experiment | null> {
  const experiment = await findExperiment(req.session!.userId, experimentId);

  if (!experiment) {
    res.status(404).json({ error: 'Experiment not found' });
    return null;
  }
  return experiment;
}
