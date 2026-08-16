import { useId } from 'react';

import { Label } from '@/components/ui/blueprint';

/**
 * A curve against request rate, with its axes labelled.
 *
 * The x-axis is load, not time, and that is the whole point of the component:
 * every value on it was solved by the same models as the headline figure, at a
 * rate that was actually sampled. The alternative -- the twenty-four hour line
 * every dashboard shows -- would be fabricated here, since nothing in the
 * platform has observed a request yet.
 *
 * The rate axis is logarithmic because the sweep is: the interesting behaviour
 * sits near the knee, and a linear axis pushes it into the left-hand tenth.
 */

export interface LoadSeries {
  label: string;
  hue: string;
  /** One value per sample, null where the model declined to answer. */
  values: readonly (number | null)[];
  format: (value: number) => string;
}

export interface LoadChartProps {
  rates: readonly number[];
  series: LoadSeries;
  /** The assumed rate, drawn as a vertical rule so the headline has a place. */
  baselineRps?: number;
  /** Where the design runs out, drawn as a second rule. */
  capacityRps?: number | null;
  height?: number;
  xLabel?: string;
}

const WIDTH = 100;
const PAD_TOP = 6;

export function LoadChart({
  rates,
  series,
  baselineRps,
  capacityRps,
  height = 160,
  xLabel = 'Requests per second',
}: LoadChartProps) {
  const gradientId = useId();
  const measured = series.values.filter((value): value is number => value !== null);

  if (rates.length < 2 || measured.length < 2) {
    return (
      <p className="text-muted-foreground py-8 text-center text-xs">
        Not enough of this architecture could be modelled to draw a curve.
      </p>
    );
  }

  const min = Math.min(...measured);
  const max = Math.max(...measured);
  const flat = max === min;
  const span = max - min || 1;

  const logMin = Math.log(rates[0]!);
  const logMax = Math.log(rates[rates.length - 1]!);
  const logSpan = logMax - logMin || 1;

  const x = (rps: number) => ((Math.log(rps) - logMin) / logSpan) * WIDTH;
  const y = (value: number) =>
    flat ? height / 2 : PAD_TOP + (1 - (value - min) / span) * (height - PAD_TOP - 1);

  const segments: string[] = [];
  let current: string[] = [];
  series.values.forEach((value, index) => {
    const rps = rates[index];
    if (value === null || rps === undefined) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${x(rps).toFixed(2)},${y(value).toFixed(2)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  return (
    <figure className="w-full">
      <div className="flex items-baseline justify-between">
        <Label>{series.label}</Label>
        <span className="tabular text-muted-foreground text-[10px]">
          {series.format(min)} to {series.format(max)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={{ height, width: '100%' }}
        className="mt-1"
        role="img"
        aria-label={`${series.label} against request rate`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`hsl(${series.hue})`} stopOpacity="0.18" />
            <stop offset="100%" stopColor={`hsl(${series.hue})`} stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1="0"
            x2={WIDTH}
            y1={PAD_TOP + fraction * (height - PAD_TOP - 1)}
            y2={PAD_TOP + fraction * (height - PAD_TOP - 1)}
            stroke="hsl(var(--border))"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {segments.length > 0 && (
          <path
            d={`${segments[0]} L${x(lastRate(rates, series.values)).toFixed(2)},${height} L${x(rates[0]!).toFixed(2)},${height} Z`}
            fill={`url(#${gradientId})`}
          />
        )}

        {segments.map((segment) => (
          <path
            key={segment.slice(0, 24)}
            d={segment}
            fill="none"
            stroke={`hsl(${series.hue})`}
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {baselineRps !== undefined && baselineRps >= rates[0]! && (
          <line
            x1={x(baselineRps)}
            x2={x(baselineRps)}
            y1={PAD_TOP}
            y2={height}
            stroke="hsl(var(--foreground))"
            strokeOpacity="0.45"
            strokeDasharray="3 3"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {capacityRps !== undefined &&
          capacityRps !== null &&
          capacityRps <= rates[rates.length - 1]! && (
            <line
              x1={x(capacityRps)}
              x2={x(capacityRps)}
              y1={PAD_TOP}
              y2={height}
              stroke="hsl(var(--destructive))"
              strokeWidth="1"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          )}
      </svg>

      <figcaption className="text-muted-foreground mt-1 flex items-baseline justify-between text-[10px]">
        <span className="tabular">{formatRate(rates[0]!)}</span>
        <span>{xLabel}</span>
        <span className="tabular">{formatRate(rates[rates.length - 1]!)}</span>
      </figcaption>

      <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
        {baselineRps !== undefined && (
          <span>
            <span className="border-foreground/50 mr-1 inline-block h-px w-3 border-t border-dashed align-middle" />
            Assumed load
          </span>
        )}
        {capacityRps !== undefined && capacityRps !== null && (
          <span>
            <span className="border-destructive mr-1 inline-block h-px w-3 border-t border-dashed align-middle" />
            Capacity, {formatRate(capacityRps)}
          </span>
        )}
      </div>
    </figure>
  );
}

function lastRate(rates: readonly number[], values: readonly (number | null)[]): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null && rates[index] !== undefined) return rates[index]!;
  }
  return rates[0]!;
}

function formatRate(rps: number): string {
  if (rps < 1) return `${rps.toFixed(2)}/s`;
  if (rps < 1000) return `${Math.round(rps)}/s`;
  return `${(rps / 1000).toFixed(1)}k/s`;
}
