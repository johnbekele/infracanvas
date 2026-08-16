import { Button } from '@/components/ui/button';
import { formatAvailabilityDelta, formatCostDelta } from '@/lib/copilot/tool-labels';
import type { ProposalView } from '@/lib/copilot/types';
import { DeltaBadge } from './DeltaBadge';

interface PatchDiffCardProps {
  proposal: ProposalView;
  onAccept: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
}

export function PatchDiffCard({ proposal, onAccept, onReject }: PatchDiffCardProps) {
  const { preview, decision } = proposal;
  const costLabel = formatCostDelta(preview.cost);
  const availabilityLabel = formatAvailabilityDelta(preview.availability);
  const pending = decision === 'pending';
  const costTone =
    preview.cost.monthlyUsdDelta > 0 ? 'up' : preview.cost.monthlyUsdDelta < 0 ? 'down' : 'neutral';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <p className="text-xs font-medium text-gray-900 dark:text-white">{proposal.summary}</p>

      <ul className="mt-2 space-y-1">
        {proposal.operations.map((op) => (
          <li key={op} className="text-[11px] text-gray-600 dark:text-gray-300">
            {op}
          </li>
        ))}
      </ul>

      <div className="mt-3 grid grid-cols-1 gap-2">
        <DeltaBadge
          label="Cost"
          value={costLabel}
          partial={preview.cost.completeness === 'partial'}
          tone={costTone}
        />
        <DeltaBadge
          label="Availability"
          value={availabilityLabel}
          partial={preview.availability.completeness === 'partial'}
        />
      </div>

      {(preview.findings.appeared.length > 0 || preview.findings.resolved.length > 0) && (
        <div className="mt-3 space-y-2">
          {preview.findings.appeared.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase text-rose-600 dark:text-rose-400">
                New findings
              </p>
              <ul className="mt-1 space-y-1">
                {preview.findings.appeared.map((f) => (
                  <li key={f.ruleId} className="text-[11px] text-gray-600 dark:text-gray-300">
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.findings.resolved.length > 0 && (
            <div>
              <p className="text-[10px] font-medium uppercase text-emerald-600 dark:text-emerald-400">
                Resolved
              </p>
              <ul className="mt-1 space-y-1">
                {preview.findings.resolved.map((f) => (
                  <li key={f.ruleId} className="text-[11px] text-gray-600 dark:text-gray-300">
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {preview.cost.completeness === 'partial' && preview.cost.unpriced.length > 0 && (
        <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">
          {preview.cost.unpriced.length} resource
          {preview.cost.unpriced.length === 1 ? '' : 's'} could not be priced; the cost is a lower
          bound.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {pending ? (
          <>
            <Button size="sm" className="h-7 text-xs" onClick={() => onAccept(proposal.proposalId)}>
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onReject(proposal.proposalId)}
            >
              Reject
            </Button>
          </>
        ) : (
          <span className="text-[11px] capitalize text-gray-500 dark:text-gray-400">
            {decision}
          </span>
        )}
      </div>
    </div>
  );
}
