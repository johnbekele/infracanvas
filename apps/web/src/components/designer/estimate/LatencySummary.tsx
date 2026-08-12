import type { PathLatency, Prediction } from '@infracanvas/core';

import { duration } from '@/lib/estimate/format';

/**
 * Latency along the request path, as a distribution rather than a single
 * number. The p95 is shown beside the median because the gap between them is
 * the thing a user feels and a mean hides, and the saturated hops are named
 * because a tail is caused by a queue somewhere specific.
 */
export function LatencySummary({ latency }: { latency: Prediction<PathLatency> | null }) {
  if (latency === null) {
    return (
      <section>
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">Latency</h4>
        <p className="mt-0.5 text-[10px] text-gray-500">
          Nothing on the request path carries a service time, so no latency is predicted.
        </p>
      </section>
    );
  }

  const { p50Ms, p95Ms, p99Ms, contributions, saturatedAt } = latency.value;
  const slowest = [...contributions].sort((a, b) => b.totalMs - a.totalMs)[0];

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">Latency</h4>
        <span className="text-lg font-semibold text-gray-900 dark:text-white">
          {duration(p95Ms)}
        </span>
      </div>

      <p className="mt-0.5 text-[10px] text-gray-500">
        p95 at the modelled request rate. Median {duration(p50Ms)}, p99 {duration(p99Ms)}, over{' '}
        {contributions.length} hop{contributions.length === 1 ? '' : 's'}.
      </p>

      {slowest !== undefined && (
        <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400">
          Slowest hop: <span className="font-medium">{slowest.resourceId}</span> at{' '}
          {duration(slowest.totalMs)}
        </p>
      )}

      {saturatedAt.length > 0 && (
        <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
          Queueing at {saturatedAt.join(', ')}. Past this point latency rises faster than load, so
          the figure above is the optimistic reading.
        </p>
      )}
    </section>
  );
}
