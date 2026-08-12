import { useMemo } from 'react';

import { summariseProposal } from '@/lib/analysis/estimate-proposal';
import { money } from '@/lib/estimate/format';
import type { RepositoryWithState } from '@/lib/api/repositories';

/**
 * What everything connected would cost together, and how much of it has actually
 * been looked at.
 *
 * A total across repositories is the figure a platform engineer is asked for and
 * the one nobody can produce by opening architectures one at a time. It is shown
 * with the count it was computed from, because a total over three of eleven
 * repositories is a different claim from a total over eleven, and a bare number
 * cannot tell them apart.
 */
export function PortfolioSummary({ repositories }: { repositories: RepositoryWithState[] }) {
  const totals = useMemo(() => {
    let monthlyUsd = 0;
    let priced = 0;
    let unpriced = 0;

    for (const repository of repositories) {
      const summary = summariseProposal(repository.succeeded?.architecture ?? null);
      if (summary === null) continue;
      monthlyUsd += summary.monthlyUsd;
      unpriced += summary.unpricedCount;
      priced += 1;
    }

    return { monthlyUsd, priced, unpriced, total: repositories.length };
  }, [repositories]);

  if (totals.priced === 0) return null;

  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm dark:border-gray-800 dark:bg-gray-900">
      <span className="font-semibold text-gray-900 dark:text-white">
        {money(totals.monthlyUsd)} a month
      </span>
      <span className="text-gray-500 dark:text-gray-400">
        predicted across {totals.priced} of {totals.total} repositor
        {totals.total === 1 ? 'y' : 'ies'}
        {totals.priced < totals.total && ', the rest not analysed yet'}.
      </span>
      {totals.unpriced > 0 && (
        <span className="text-gray-400">
          {totals.unpriced} resource{totals.unpriced === 1 ? '' : 's'} carry no price yet, so this
          is a floor rather than an estimate.
        </span>
      )}
    </div>
  );
}
