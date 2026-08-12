import type { BottleneckReport, Prediction } from '@infracanvas/core';

import { rate } from '@/lib/estimate/format';

/**
 * The rate at which this architecture stops holding, and what stops it. It is
 * the answer to the question a cost figure cannot reach: not what the design
 * costs, but how far it goes before something has to change.
 *
 * An adjustable quota is called out separately because it is usually the
 * cheapest finding on the page - nothing about the architecture is wrong, and
 * asking AWS for more is the entire fix.
 */
export function BottleneckSummary({ report }: { report: Prediction<BottleneckReport> }) {
  const { first, targetRps, ranked } = report.value;

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">Scale ceiling</h4>
        <span className="text-lg font-semibold text-gray-900 dark:text-white">
          {first === null ? 'None found' : rate(first.breakingRps)}
        </span>
      </div>

      {first === null ? (
        <p className="mt-0.5 text-[10px] text-gray-500">
          No limit in the table is reached below the ceiling the solver sweeps to. That is not proof
          the architecture scales; it means nothing modelled here stops it first.
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-[10px] text-gray-500">
            Modelled at {rate(targetRps)}, so there is {rate(Math.max(first.headroomRps, 0))} of
            headroom before <span className="font-medium">{first.resourceId}</span> reaches its{' '}
            {first.label.toLowerCase()}.
          </p>
          <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400">{first.remedy}</p>
          {first.adjustable && (
            <p className="mt-1 text-[10px] text-emerald-700 dark:text-emerald-400">
              This one is a quota rather than a design limit. AWS can raise it.
            </p>
          )}
        </>
      )}

      {ranked.length > 1 && (
        <p className="mt-1 text-[10px] text-gray-500">
          {ranked.length - 1} further limit{ranked.length === 2 ? '' : 's'} behind it.
        </p>
      )}
    </section>
  );
}
