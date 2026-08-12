import type { ArchitectureProposal } from '@infracanvas/core';

import { proposalToFlow } from '@/lib/architecture/to-flow';
import { estimateArchitecture } from '@/lib/estimate/estimate';
import { canvasStoreToIr } from '@/lib/estimate/to-ir';

/**
 * What a proposed architecture would cost and how available it would be, in the
 * few figures a list of repositories has room for.
 *
 * The same models the estimate panel uses, reached through the same conversion,
 * so a figure on this page and the figure beside the canvas cannot disagree. It
 * runs in the browser for the same reason the panel does: pure functions over a
 * dozen nodes, and a round trip per card would make a list feel like a report.
 */
export interface ProposalSummary {
  serviceCount: number;
  monthlyUsd: number;
  /** How many resources carry no price yet, so a small total can be read correctly. */
  unpricedCount: number;
  availability: number;
  /** Every Well-Architected finding, so a card can say there is something to read. */
  findings: number;
  /**
   * Those at high severity. Separate from the total because the two deserve
   * different words on a card: a public database is a thing to fix before
   * deploying, and a single availability zone is a thing to decide about.
   */
  highSeverity: number;
}

export function summariseProposal(proposal: ArchitectureProposal | null): ProposalSummary | null {
  if (proposal === null || proposal.nodes.length === 0) return null;

  try {
    const flow = proposalToFlow(proposal);
    const { document } = canvasStoreToIr(flow.nodes, flow.edges);
    const estimate = estimateArchitecture(document);

    return {
      serviceCount: document.nodes.length,
      monthlyUsd: estimate.cost.value.monthlyUsd,
      unpricedCount: estimate.cost.value.unpriced.length,
      availability: estimate.availability.value.compositeAvailability,
      findings: estimate.findings.findings.length,
      highSeverity: estimate.findings.findings.filter((finding) => finding.severity === 'high')
        .length,
    };
  } catch {
    // A proposal the models cannot read is not worth failing a page over. The
    // card shows what it knows and omits the figures, which is honest; throwing
    // here would take the repository list down with it.
    return null;
  }
}
