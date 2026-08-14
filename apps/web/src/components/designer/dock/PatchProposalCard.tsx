import { useState } from 'react';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { downtime, money, percent } from '@/lib/estimate/format';
import type { PatchProposedEvent } from '@/lib/copilot/events';

interface PatchProposalCardProps {
  proposal: PatchProposedEvent;
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
}

/**
 * An edit the copilot wants to make, with what it would cost and what it would
 * buy, before anything is applied.
 *
 * The card leads with the two figures a decision actually turns on - the change
 * in monthly cost and the change in availability - because "add a read replica"
 * is not a decision anyone can make, and "$47 more a month for another nine" is.
 * Incompleteness is stated rather than rounded away: a delta computed over
 * resources the models could not all price is a bound, and saying so is what
 * makes the figures beside it worth reading.
 */
export function PatchProposalCard({ proposal, onAccept, onReject }: PatchProposalCardProps) {
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { preview, summary, touchedNodeIds } = proposal;

  const run = async (which: 'accept' | 'reject', action: () => Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'That could not be applied. Try again.'
      );
      setBusy(null);
    }
  };

  if (!preview.applicable) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950/30">
        <p className="text-[11px] font-medium text-amber-900 dark:text-amber-200">{summary}</p>
        <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-300">
          This no longer applies to the architecture as it stands
          {preview.problems[0] !== undefined && `: ${preview.problems[0].message}`}.
        </p>
      </div>
    );
  }

  const cost = preview.cost;
  const availability = preview.availability;
  const cheaper = cost.monthlyUsdDelta < 0;

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-2.5 dark:border-violet-900 dark:bg-violet-950/25">
      <p className="text-[11px] font-medium text-gray-900 dark:text-white">{summary}</p>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Delta
          label="Monthly cost"
          value={`${cheaper ? '−' : '+'}${money(Math.abs(cost.monthlyUsdDelta))}`}
          detail={`${money(cost.monthlyUsdBefore)} → ${money(cost.monthlyUsdAfter)}`}
          tone={cost.monthlyUsdDelta === 0 ? 'flat' : cheaper ? 'good' : 'bad'}
          partial={cost.completeness === 'partial'}
        />
        <Delta
          label="Availability"
          value={`${percent(availability.before)} → ${percent(availability.after)}`}
          detail={`${downtime(availability.after)} of downtime`}
          tone={availability.delta === 0 ? 'flat' : availability.delta > 0 ? 'good' : 'bad'}
          partial={availability.completeness === 'partial'}
        />
      </div>

      {(preview.findings.resolved.length > 0 || preview.findings.appeared.length > 0) && (
        <p className="mt-2 text-[10px] text-gray-600 dark:text-gray-400">
          {preview.findings.resolved.length > 0 &&
            `Resolves ${preview.findings.resolved.length} finding${preview.findings.resolved.length === 1 ? '' : 's'}`}
          {preview.findings.resolved.length > 0 && preview.findings.appeared.length > 0 && ', '}
          {preview.findings.appeared.length > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              introduces {preview.findings.appeared.length}
            </span>
          )}
          .
        </p>
      )}

      <p className="mt-1 text-[10px] text-gray-500">
        Touches {touchedNodeIds.length} resource{touchedNodeIds.length === 1 ? '' : 's'}:{' '}
        {touchedNodeIds.slice(0, 3).join(', ')}
        {touchedNodeIds.length > 3 && ` and ${touchedNodeIds.length - 3} more`}
      </p>

      {error !== null && (
        <p className="mt-1.5 text-[10px] text-rose-700 dark:text-rose-400">{error}</p>
      )}

      <div className="mt-2 flex gap-1.5">
        <Button
          size="sm"
          className="h-7 flex-1 gap-1 text-[11px]"
          disabled={busy !== null}
          onClick={() => void run('accept', onAccept)}
        >
          {busy === 'accept' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          Apply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-[11px]"
          disabled={busy !== null}
          onClick={() => void run('reject', onReject)}
        >
          <X className="h-3 w-3" />
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function Delta({
  label,
  value,
  detail,
  tone,
  partial,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'bad' | 'flat';
  partial: boolean;
}) {
  const colour =
    tone === 'good'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'bad'
        ? 'text-rose-700 dark:text-rose-400'
        : 'text-gray-900 dark:text-white';

  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-xs font-semibold ${colour}`}>{value}</p>
      <p className="text-[9px] text-gray-500">{detail}</p>
      {partial && (
        <p className="mt-0.5 flex items-center gap-1 text-[9px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-2.5 w-2.5" />a bound, not a figure
        </p>
      )}
    </div>
  );
}
