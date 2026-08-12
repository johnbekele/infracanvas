import { RotateCcw } from 'lucide-react';
import type { Assumption } from '@infracanvas/core';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Every guess behind the figures above, as an input.
 *
 * This is what makes the estimate arguable rather than authoritative. A reader
 * who thinks two million requests a month is nonsense can see the figure, the
 * unit and the sentence explaining where it came from, change it, and watch the
 * totals move.
 */
export function AssumptionEditor({
  assumptions,
  onChange,
  onReset,
}: {
  assumptions: Assumption[];
  onChange: (id: string, value: number) => void;
  onReset: () => void;
}) {
  const edited = assumptions.filter((assumption) => assumption.source !== 'default').length;

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300">Assumptions</h4>
        {edited > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[10px]"
            onClick={onReset}
          >
            <RotateCcw className="h-3 w-3" />
            Reset {edited}
          </Button>
        )}
      </div>

      <div className="mt-1.5 space-y-2.5">
        {assumptions.map((assumption) => (
          <div key={assumption.id}>
            <Label
              htmlFor={assumption.id}
              className="flex items-center justify-between text-[11px]"
            >
              <span>{assumption.label}</span>
              {assumption.source !== 'default' && (
                <span className="text-[9px] uppercase tracking-wide text-sky-600 dark:text-sky-400">
                  {assumption.source === 'user' ? 'yours' : 'from your repository'}
                </span>
              )}
            </Label>
            <div className="mt-0.5 flex items-center gap-1.5">
              <Input
                id={assumption.id}
                type="number"
                min={0}
                value={assumption.value}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  // A blank or negative input would price the architecture from
                  // a figure the user is in the middle of typing.
                  if (Number.isFinite(next) && next >= 0) onChange(assumption.id, next);
                }}
                className="h-7 text-xs"
              />
              <span className="w-16 shrink-0 text-[10px] text-gray-500">{assumption.unit}</span>
            </div>
            <p className="mt-0.5 text-[9px] leading-snug text-gray-500">{assumption.rationale}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
