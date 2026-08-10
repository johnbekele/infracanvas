import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { ArchitectureProposal } from '@infracanvas/core';
import { Button } from '@/components/ui/button';
import { useDesignerStore } from '@/lib/stores/designer-store';
import { proposalToFlow } from '@/lib/architecture/to-flow';

interface ArchitectureProposalPanelProps {
  proposal: ArchitectureProposal;
}

/**
 * The proposed architecture, shown as the reasoning behind it rather than only
 * as a diagram. A user has to be able to disagree with a suggestion, and they
 * can only do that if they can see which file in their repository caused it.
 */
export function ArchitectureProposalPanel({ proposal }: ArchitectureProposalPanelProps) {
  const navigate = useNavigate();
  const loadDesign = useDesignerStore((state) => state.loadDesign);

  const openInDesigner = () => {
    const { nodes, edges } = proposalToFlow(proposal);
    loadDesign(nodes, edges, proposal.name);
    navigate('/designer');
  };

  const hasArchitecture = proposal.nodes.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Proposed architecture
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {hasArchitecture
              ? `${proposal.nodes.length} resources, derived from the analysis above.`
              : 'Nothing was proposed for this repository.'}
          </p>
        </div>

        {hasArchitecture && (
          <Button onClick={openInDesigner}>
            Open in designer
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
      </div>

      {proposal.decisions.length > 0 && (
        <ul className="space-y-3">
          {proposal.decisions.map((decision) => (
            <li
              key={decision.nodeId}
              className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
            >
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                {decision.title}
              </h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{decision.rationale}</p>
              {decision.evidence.length > 0 && (
                <p className="mt-2 font-mono text-[11px] text-gray-400">
                  {decision.evidence.join(', ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {proposal.gaps.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            Not covered
          </h3>
          <ul className="list-inside list-disc space-y-1 text-sm text-amber-800 dark:text-amber-300">
            {proposal.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
