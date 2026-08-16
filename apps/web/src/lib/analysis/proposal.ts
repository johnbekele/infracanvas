/**
 * Choosing which architecture proposal to show for a repository.
 *
 * The server synthesises the proposal when an analysis completes and stores it
 * with the profile, so the browser reads a decision that was recorded rather
 * than one it invented on the way to rendering.
 */
import { proposeArchitecture, type ArchitectureProposal } from '@infracanvas/core';
import type { Analysis } from '@/lib/api/repositories';

/**
 * The newest successful run.
 *
 * Analyses arrive newest first, and a later failed attempt should not erase the
 * profile the user was already looking at.
 */
export function latestSucceeded(analyses: Analysis[] | undefined): Analysis | null {
  return analyses?.find((analysis) => analysis.status === 'succeeded') ?? null;
}

/**
 * The proposal to show, stored if there is one.
 *
 * Runs that succeeded before the proposal was persisted have a profile and no
 * architecture. Synthesis is deterministic and already ships in the browser
 * bundle, so those pages are served from a recomputed proposal rather than being
 * blanked until the user re-analyses -- a re-analysis spends their GitHub rate
 * limit and records a new run, which is a lot to ask for a page they only opened
 * to read. Anything analysed from now on takes the stored path.
 */
export function proposalFor(
  analysis: Analysis | null,
  repositoryName: string | undefined
): ArchitectureProposal | null {
  if (!analysis) return null;
  if (analysis.architecture) return analysis.architecture;
  if (!analysis.profile || !repositoryName) return null;

  return proposeArchitecture(analysis.profile, repositoryName);
}
