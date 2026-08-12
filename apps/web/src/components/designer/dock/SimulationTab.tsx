import { useEstimate } from '@/lib/estimate/use-estimate';

import { AssumptionEditor } from '../estimate/AssumptionEditor';
import { AvailabilitySummary } from '../estimate/AvailabilitySummary';
import { BottleneckSummary } from '../estimate/BottleneckSummary';
import { CostBreakdown } from '../estimate/CostBreakdown';
import { FindingsList } from '../estimate/FindingsList';
import { LatencySummary } from '../estimate/LatencySummary';
import { SloProposals } from '../estimate/SloProposals';

/**
 * What the architecture on the canvas would cost, how available it would be,
 * how fast it would answer, where it would stop scaling, and where it departs
 * from the Well-Architected Framework - with every assumption behind those
 * figures as an editable input.
 *
 * The panel shows its working on purpose. A tool that answers "$412 a month"
 * and stops is asking to be trusted; one that names the rate, the quantity, the
 * assumption the quantity came from and the things it could not price is asking
 * to be checked, which is the only basis on which anyone should act on it.
 */
export function SimulationTab() {
  const { estimate, skipped, error, overrideAssumption, resetAssumptions } = useEstimate();

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-3">
      {error !== null && (
        <p className="rounded-md bg-rose-50 p-2 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      )}

      {estimate === null && error === null && (
        <p className="text-[11px] text-gray-500">
          Nothing on the canvas yet. Drop a service, or open a repository and let the analysis
          propose one, and every figure here follows from it.
        </p>
      )}

      {estimate !== null && (
        <>
          <CostBreakdown cost={estimate.cost} />
          <AvailabilitySummary report={estimate.availability} />
          <LatencySummary latency={estimate.latency} />
          <BottleneckSummary report={estimate.bottleneck} />
          <SloProposals slos={estimate.slos} />
          <FindingsList findings={estimate.findings} />

          {skipped.length > 0 && (
            <section>
              <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">
                Left out of every figure
              </h4>
              <ul className="mt-1 space-y-0.5 text-[10px] text-gray-500">
                {skipped.map((node) => (
                  <li key={node.id}>
                    {node.name} {node.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="border-t border-gray-200 pt-3 dark:border-gray-800">
            <AssumptionEditor
              assumptions={estimate.assumptions}
              onChange={overrideAssumption}
              onReset={resetAssumptions}
            />
          </div>
        </>
      )}
    </div>
  );
}
