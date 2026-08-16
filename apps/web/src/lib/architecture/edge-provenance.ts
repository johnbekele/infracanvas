/**
 * Telling the user how much of the wiring they wrote themselves.
 *
 * The canvas already distinguishes a declared connection from an inferred one by
 * drawing it solid rather than dashed, but a line style nobody explained is a
 * line style nobody reads. One sentence beside the decisions says which is which
 * and how many of each there are, so a user knows whether they are reviewing
 * their own topology or the engine's guess at it.
 */
import type { ProposedEdge } from '@infracanvas/core';

export interface EdgeProvenance {
  /** Connections the repository states in a compose `depends_on`. */
  declared: number;
  /** Connections this engine derived, from capability overlap or architecture shape. */
  inferred: number;
}

export function edgeProvenance(edges: readonly ProposedEdge[]): EdgeProvenance {
  let declared = 0;

  for (const edge of edges) {
    if (edge.origin === 'declared') declared += 1;
  }

  return { declared, inferred: edges.length - declared };
}

/**
 * The sentence to show, or null when there is nothing worth saying.
 *
 * A proposal with no connections has nothing to explain, and neither does one
 * where every connection came from the same place -- claiming "0 of 4 declared"
 * is noise for the majority of repositories, which have no compose file at all.
 */
export function provenanceSentence(provenance: EdgeProvenance): string | null {
  const { declared, inferred } = provenance;
  const total = declared + inferred;

  if (total === 0) return null;

  if (declared === 0) {
    return `All ${total} connection(s) were inferred from the dependencies each component declares, and are drawn dashed. Nothing in this repository states what talks to what.`;
  }

  if (inferred === 0) {
    return `All ${total} connection(s) come from a compose \`depends_on\` in this repository, and are drawn solid.`;
  }

  return `${declared} of ${total} connection(s) come from a compose \`depends_on\` in this repository and are drawn solid; the other ${inferred} were inferred from declared dependencies and are drawn dashed.`;
}
