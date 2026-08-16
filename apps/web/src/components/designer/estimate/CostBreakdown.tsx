import { AlertTriangle } from 'lucide-react';
import type { ArchitectureCost, Prediction } from '@infracanvas/core';

import { money, quantity } from '@/lib/estimate/format';

/**
 * The total, then every line that makes it up, then everything that is missing
 * from it. The third part is the one that keeps the first honest: a figure that
 * does not say what it left out reads as complete.
 */
export function CostBreakdown({ cost }: { cost: Prediction<ArchitectureCost> }) {
  const priced = cost.value.byResource.filter((resource) => resource.lines.length > 0);
  const source = priced[0]?.priceSource;

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">Monthly cost</h4>
        <span className="text-lg font-semibold text-gray-900 dark:text-white">
          {money(cost.value.monthlyUsd)}
        </span>
      </div>
      <p className="mt-0.5 text-[10px] text-gray-500">
        Predicted, on-demand, before tax and before any discount.
      </p>

      {priced.length > 0 && (
        <table className="mt-2 w-full text-[11px]">
          <tbody>
            {priced.flatMap((resource) =>
              resource.lines.map((line) => (
                <tr key={`${resource.resourceId}-${line.label}`} className="align-top">
                  <td className="py-0.5 pr-2 text-gray-600 dark:text-gray-400">
                    {line.label}
                    <span className="block text-[9px] text-gray-400">
                      {quantity(line.quantity, line.unit)} at ${line.unitPriceUsd}
                    </span>
                  </td>
                  <td className="py-0.5 text-right tabular-nums text-gray-900 dark:text-gray-200">
                    {money(line.monthlyUsd)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}

      {cost.value.unpriced.length > 0 && (
        <div className="mt-2 rounded-md bg-amber-50 p-2 dark:bg-amber-950/30">
          <p className="flex items-center gap-1 text-[10px] font-medium text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            Not included in this total
          </p>
          <ul className="mt-1 space-y-0.5 text-[10px] text-amber-700 dark:text-amber-400">
            {cost.value.unpriced.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      )}

      {source && (
        <p className="mt-2 text-[9px] text-gray-400">
          Prices from AWS price list {source.priceListVersion}, published{' '}
          {source.capturedAt.slice(0, 10)}.
        </p>
      )}
    </section>
  );
}
