import { proposeArchitecture, type AppProfile } from '@infracanvas/core';

import type { FileCitation } from './models.js';

/**
 * Repository paths behind a node, or nothing.
 *
 * The grounding limit here has to be stated rather than papered over.
 * `packages/core/src/analysis/architecture.ts` produces decisions carrying the
 * manifest, Dockerfile and dependency paths each node was drawn from, but
 * nothing persists them: `analyses` stores the profile, and the proposal is
 * recomputed. So the proposal is recomputed here too, from the stored profile,
 * by the same deterministic function that produced the document in the first
 * place - which is why a path returned here is one the analysis actually read,
 * rather than one that merely looks right.
 *
 * A node the profile cannot account for - one the user drew, or one whose id
 * was changed - returns an empty list. Empty is the correct answer; a plausible
 * path is the failure this epic cannot afford, because a user who checks one
 * citation and finds it invented stops checking the rest.
 */
export function evidenceForNode(
  profile: AppProfile | null,
  repositoryName: string,
  nodeId: string
): FileCitation[] {
  if (profile === null) return [];

  const proposal = proposeArchitecture(profile, repositoryName);
  const decision = proposal.decisions.find((entry) => entry.nodeId === nodeId);
  if (decision === undefined) return [];

  return decision.evidence.map((path) => ({ path, reason: decision.title }));
}
