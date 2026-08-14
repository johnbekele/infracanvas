import type { ReactNode } from 'react';

import { Corners, Figure, Label } from '@/components/ui/blueprint';
import { Sparkline } from './charts/Sparkline';

/**
 * One headline figure, what it means in plain words, and the curve behind it.
 *
 * The curve is against request rate rather than time, so the tile answers "and
 * at three times the load?" without the reader having to open a tab. Where a
 * model declined to answer -- a latency past saturation -- the line simply
 * stops, and the caption says why.
 */
export function HeroTile({
  label,
  value,
  unit,
  caption,
  hue,
  values,
  markerIndex,
  footer,
}: {
  label: string;
  value: string;
  unit?: string;
  caption: string;
  hue: string;
  values?: readonly (number | null)[];
  markerIndex?: number;
  footer?: ReactNode;
}) {
  return (
    <div className="border-border bg-card relative border p-3">
      <Corners />
      <Label>{label}</Label>
      <div className="mt-1.5">
        <Figure value={value} unit={unit} />
      </div>
      <p className="text-muted-foreground mt-1 text-[11px] leading-snug">{caption}</p>

      {values !== undefined && (
        <div className="mt-2">
          <Sparkline values={values} hue={hue} markerIndex={markerIndex} height={34} />
        </div>
      )}

      {footer !== undefined && (
        <div className="text-muted-foreground mt-1 text-[10px]">{footer}</div>
      )}
    </div>
  );
}
