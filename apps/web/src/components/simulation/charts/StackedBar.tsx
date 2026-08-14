import { Label } from '@/components/ui/blueprint';

/**
 * How a total divides. Used for cost by category and for latency by hop.
 *
 * A bar rather than a pie: the question is always "which slice dominates and by
 * how much", which is a length comparison, and a legend beneath a bar can carry
 * the exact figure that a pie chart's angles only approximate.
 */

export interface Slice {
  key: string;
  label: string;
  value: number;
  colour: string;
  /** Shown under the label, e.g. the share or the resource it came from. */
  note?: string;
}

export function StackedBar({
  slices,
  format,
  title,
}: {
  slices: readonly Slice[];
  format: (value: number) => string;
  title?: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) {
    return <p className="text-muted-foreground text-xs">Nothing here carries a figure yet.</p>;
  }

  return (
    <div>
      {title !== undefined && <Label className="mb-1 block">{title}</Label>}
      <div className="border-border flex h-3 w-full overflow-hidden border">
        {slices.map((slice) => (
          <span
            key={slice.key}
            title={`${slice.label} ${format(slice.value)}`}
            style={{ width: `${(slice.value / total) * 100}%`, background: slice.colour }}
          />
        ))}
      </div>
      <ul className="mt-2 space-y-1">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-baseline gap-2 text-xs">
            <span
              className="mt-1 h-2 w-2 shrink-0"
              style={{ background: slice.colour }}
              aria-hidden
            />
            <span className="flex-1 truncate">
              {slice.label}
              {slice.note !== undefined && (
                <span className="text-muted-foreground ml-1 text-[10px]">{slice.note}</span>
              )}
            </span>
            <span className="tabular text-muted-foreground shrink-0">
              {((slice.value / total) * 100).toFixed(0)}%
            </span>
            <span className="tabular w-16 shrink-0 text-right font-medium">
              {format(slice.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
