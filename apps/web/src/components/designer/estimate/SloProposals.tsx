import type { Prediction, SloProposal } from '@infracanvas/core';

import { percent } from '@/lib/estimate/format';

/**
 * Objectives with the query that measures each one. An SLO without an SLI is a
 * wish, so the metric expression is shown rather than described.
 */
export function SloProposals({ slos }: { slos: Prediction<SloProposal[]> }) {
  if (slos.value.length === 0) {
    return (
      <section>
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">
          Proposed objectives
        </h4>
        <p className="mt-1 text-[10px] text-gray-500">
          {slos.gaps[0] ?? 'Nothing on the canvas can carry an objective yet.'}
        </p>
      </section>
    );
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">Proposed objectives</h4>
      <ul className="mt-1.5 space-y-2">
        {slos.value.map((proposal) => (
          <li
            key={`${proposal.objective}-${proposal.target}`}
            className="rounded-md border border-gray-200 p-2 dark:border-gray-800"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-medium capitalize text-gray-800 dark:text-gray-200">
                {proposal.objective}
              </span>
              <span className="text-xs font-semibold tabular-nums text-gray-900 dark:text-white">
                {proposal.unit === 'fraction'
                  ? percent(proposal.target)
                  : `${proposal.target.toFixed(0)}ms`}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-gray-500">
              {proposal.errorBudgetMinutes.toFixed(0)} minutes of error budget over{' '}
              {proposal.window}.
            </p>
            <p className="mt-1 text-[10px] text-gray-600 dark:text-gray-400">
              {proposal.rationale}
            </p>
            <dl className="mt-1.5 space-y-0.5">
              <div>
                <dt className="text-[9px] uppercase tracking-wide text-gray-400">Good</dt>
                <dd className="break-words font-mono text-[9px] text-gray-600 dark:text-gray-400">
                  {proposal.sli.goodEvents}
                </dd>
              </div>
              <div>
                <dt className="text-[9px] uppercase tracking-wide text-gray-400">Total</dt>
                <dd className="break-words font-mono text-[9px] text-gray-600 dark:text-gray-400">
                  {proposal.sli.totalEvents}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
