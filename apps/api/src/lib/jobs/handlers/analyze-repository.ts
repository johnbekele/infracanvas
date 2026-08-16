/**
 * The queued form of a repository analysis.
 *
 * The payload carries identifiers and nothing else. A GitHub token in a `jobs`
 * row would be a credential at rest in a table whose whole purpose is to outlive
 * the request: readable by anyone who can read the queue, and still there after
 * the user disconnects the repository. The handler looks the token up when it
 * runs, which also means a revoked token fails the run rather than being used
 * from a stale copy.
 */
import { proposeArchitecture } from '@infracanvas/core';
import { analyzeRepository } from '../../analysis/analyze.js';
import { GitHubSourceError } from '../../analysis/github-source.js';
import { beginAnalysis, completeAnalysis, failAnalysis, findAnalysis } from '../../db/analyses.js';
import { findRepository } from '../../db/repositories.js';
import { getGitHubToken } from '../../db/tokens.js';
import {
  NonRetryableJobError,
  type JobContext,
  type JobHandler,
  type JobPayload,
} from '../types.js';

export const ANALYZE_REPOSITORY = 'analysis.repository';

export interface AnalyzeRepositoryPayload {
  analysisId: string;
  repositoryId: string;
  userId: string;
  ref: string;
}

/**
 * Narrow a payload read back from `jsonb`.
 *
 * The row was written by this process, but by whichever version of it was
 * deployed at the time. A job enqueued before a payload change and claimed after
 * it is an ordinary deployment, not a corrupt database, and it should fail saying
 * what is missing rather than with a `TypeError` from deep inside the analysis.
 */
export function parseAnalyzePayload(payload: JobPayload): AnalyzeRepositoryPayload {
  const fields = ['analysisId', 'repositoryId', 'userId', 'ref'] as const;
  const missing = fields.filter((field) => typeof payload[field] !== 'string' || !payload[field]);

  if (missing.length > 0) {
    throw new NonRetryableJobError(`This job's payload is missing: ${missing.join(', ')}.`);
  }

  return {
    analysisId: payload.analysisId as string,
    repositoryId: payload.repositoryId as string,
    userId: payload.userId as string,
    ref: payload.ref as string,
  };
}

/**
 * Whether a GitHub failure is worth another attempt.
 *
 * A 404 or a 401 fails identically three times: the repository is gone, or the
 * token does not work. A 429 is the clearest case for retrying, since the
 * backoff is exactly the remedy, and a 5xx is usually transient.
 */
function isRetryable(error: GitHubSourceError): boolean {
  return error.status === 429 || error.status >= 500;
}

export function analyzeRepositoryHandler(): JobHandler {
  return {
    kind: ANALYZE_REPOSITORY,

    async handle(raw: JobPayload, ctx: JobContext): Promise<void> {
      const payload = parseAnalyzePayload(raw);

      try {
        await run(payload, ctx);
      } catch (error) {
        // A GitHub 404 or 401 will fail the same way on every attempt, so it is
        // re-thrown as permanent. Anything else is left to the queue's retries,
        // and the message is written to the stream so the user watching sees the
        // reason for the pause rather than a stall.
        if (error instanceof GitHubSourceError && !isRetryable(error)) {
          throw new NonRetryableJobError(error.message);
        }

        await ctx.log(
          'warn',
          error instanceof GitHubSourceError ? error.message : 'Analysis failed unexpectedly.'
        );
        throw error;
      }
    },

    // The `analyses` row is what the repository page reads, so it has to reflect
    // the outcome even though the job row records it too. Done here rather than
    // in `handle` because only the queue knows which attempt was the last.
    async onExhausted(raw: JobPayload, error: string): Promise<void> {
      const analysisId = raw.analysisId;
      if (typeof analysisId !== 'string') return;

      // Only a run still in flight. An analysis that succeeded on an attempt the
      // queue never heard about must not be reopened as a failure.
      const analysis = await findAnalysis(analysisId);
      if (analysis?.status !== 'pending' && analysis?.status !== 'running') return;

      await failAnalysis(analysisId, error);
    },
  };
}

async function run(payload: AnalyzeRepositoryPayload, ctx: JobContext): Promise<void> {
  const analysis = await beginAnalysis(payload.analysisId);

  // Either the row is gone, or an earlier attempt finished after its lease
  // lapsed and this one is a duplicate. Redoing it would spend a dozen GitHub
  // requests to overwrite a result with an identical one.
  if (!analysis) {
    await ctx.log('info', 'This analysis has already finished.');
    return;
  }

  // Looked up by owner as well as id, so a repository disconnected between
  // enqueue and run is not analysed on behalf of someone who no longer has it.
  const repository = await findRepository(payload.userId, payload.repositoryId);
  if (!repository) {
    throw new NonRetryableJobError(
      'The repository this job was created for is no longer connected.'
    );
  }

  const token = await getGitHubToken(payload.userId);
  if (!token) {
    throw new NonRetryableJobError(
      'The GitHub token for this account is no longer available. Reconnect GitHub and try again.'
    );
  }

  await ctx.progress(
    0.02,
    `Analysing ${repository.githubOwner}/${repository.githubName} at ${payload.ref}.`
  );

  const profile = await analyzeRepository({
    token,
    owner: repository.githubOwner,
    repo: repository.githubName,
    ref: payload.ref,
    signal: ctx.signal,
    onProgress: (fraction, message) => ctx.progress(fraction, message),
  });

  await ctx.progress(0.95, 'Proposing an architecture for what the code needs.');

  // Synthesised here rather than in the browser. The proposal is the record of
  // what was decided about this commit, each decision with its rationale and the
  // files it rests on, and recomputing it on every page load threw that record
  // away as soon as the user navigated.
  const architecture = proposeArchitecture(profile, repository.githubName);

  await completeAnalysis(payload.analysisId, profile, architecture);
}
