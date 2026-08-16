import type { AvailabilityReport, Prediction } from '@infracanvas/core';

import { downtime, percent } from '@/lib/estimate/format';

/**
 * The composite figure, the component that holds it down, and what it costs in
 * downtime. The weakest link is shown beside the number because it is the only
 * actionable half: a percentage tells you where you are, the weakest link tells
 * you what to change.
 */
export function AvailabilitySummary({ report }: { report: Prediction<AvailabilityReport> }) {
  const { compositeAvailability, weakest, nodes, unmodelled } = report.value;
  const published = nodes.filter((node) => node.basis === 'published').length;

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">Availability</h4>
        <span className="text-lg font-semibold text-gray-900 dark:text-white">
          {nodes.length === 0 ? 'Not modelled' : percent(compositeAvailability)}
        </span>
      </div>

      {nodes.length > 0 && (
        <>
          <p className="mt-0.5 text-[10px] text-gray-500">
            {downtime(compositeAvailability)} of allowed downtime.
            {published > 0 && ` ${published} of ${nodes.length} from a published AWS SLA.`}
          </p>
          {weakest !== '' && (
            <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400">
              Weakest link on the path: <span className="font-medium">{weakest}</span>
            </p>
          )}
        </>
      )}

      {unmodelled.length > 0 && (
        <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
          {unmodelled.length} resource{unmodelled.length === 1 ? '' : 's'} could not be modelled, so
          the real figure is no better than this one and may be worse.
        </p>
      )}
    </section>
  );
}
