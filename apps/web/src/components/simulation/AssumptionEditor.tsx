import { RotateCcw } from 'lucide-react';
import type { Assumption } from '@infracanvas/core';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/blueprint';

/**
 * Every guess behind the figures, as an input.
 *
 * This is what makes the simulation arguable rather than authoritative. A
 * reader who thinks two million requests a month is nonsense can see the
 * figure, the unit and the sentence explaining where it came from, change it,
 * and watch every total on the page move.
 *
 * Overrides are shared across the whole app, so an argument made here is the
 * one the dock beside the canvas is quoting too.
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
        <h4 className="font-heading text-sm font-semibold uppercase tracking-wide">Assumptions</h4>
        {edited > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="border-border hover:bg-secondary flex items-center gap-1 border px-1.5 py-0.5 text-[10px]"
          >
            <RotateCcw className="h-3 w-3" />
            Reset {edited}
          </button>
        )}
      </div>

      <p className="text-muted-foreground mt-1 text-[10px] leading-snug">
        Change any of these and every figure on this page recomputes.
      </p>

      <div className="mt-3 space-y-3">
        {assumptions.map((assumption) => (
          <div key={assumption.id}>
            <div className="flex items-center justify-between">
              <label htmlFor={assumption.id} className="text-[11px] font-medium">
                {assumption.label}
              </label>
              {assumption.source !== 'default' && (
                <Label className="text-primary">
                  {assumption.source === 'user' ? 'yours' : 'from your repository'}
                </Label>
              )}
            </div>
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
                className="tabular h-7 text-xs"
              />
              <span className="text-muted-foreground w-16 shrink-0 text-[10px]">
                {assumption.unit}
              </span>
            </div>
            <p className="text-muted-foreground mt-0.5 text-[9px] leading-snug">
              {assumption.rationale}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
