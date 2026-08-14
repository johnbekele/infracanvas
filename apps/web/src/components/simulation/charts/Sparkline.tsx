import { useId } from 'react';

/**
 * A curve behind a headline figure.
 *
 * Hand-rolled SVG rather than a charting library: these draw two dozen sampled
 * points with no legend, no tooltip and no interaction, and the smallest chart
 * library that does that is larger than the page it would sit on. It also keeps
 * the axis honest -- there is nowhere here to accidentally interpolate between
 * samples the models never computed.
 *
 * Points that are null (a latency past saturation) break the line rather than
 * being bridged, because a continuous line across a gap claims a value the
 * model refused to give.
 */

export interface SparklineProps {
  values: readonly (number | null)[];
  /** Index of the point the headline figure corresponds to, marked with a dot. */
  markerIndex?: number;
  /** hsl() triple from the token block, so a colour means one model everywhere. */
  hue: string;
  height?: number;
  className?: string;
}

const WIDTH = 100;

export function Sparkline({ values, markerIndex, hue, height = 32, className }: SparklineProps) {
  const gradientId = useId();
  const measured = values.filter((value): value is number => value !== null);
  if (measured.length < 2) return <div style={{ height }} className={className} />;

  const min = Math.min(...measured);
  const max = Math.max(...measured);
  // A flat series is a true answer -- a cost that does not move with traffic is
  // worth seeing as a flat line rather than as noise amplified to fill the box.
  // It is drawn through the middle, because a line pinned to the floor reads as
  // a value of zero.
  const flat = max === min;
  const span = max - min || 1;

  const x = (index: number) => (index / (values.length - 1)) * WIDTH;
  const y = (value: number) =>
    flat ? height / 2 : height - ((value - min) / span) * (height - 2) - 1;

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(
      `${current.length === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)}`
    );
  });
  if (current.length > 1) segments.push(current.join(' '));

  let lastMeasured = -1;
  values.forEach((value, index) => {
    if (value !== null) lastMeasured = index;
  });
  const area =
    segments.length > 0 && lastMeasured >= 0
      ? `${segments[0]} L${x(lastMeasured).toFixed(2)},${height} L0,${height} Z`
      : '';

  const marker = markerIndex !== undefined ? values[markerIndex] : undefined;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ height, width: '100%' }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`hsl(${hue})`} stopOpacity="0.22" />
          <stop offset="100%" stopColor={`hsl(${hue})`} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area !== '' && <path d={area} fill={`url(#${gradientId})`} />}
      {segments.map((segment) => (
        <path
          key={segment.slice(0, 24)}
          d={segment}
          fill="none"
          stroke={`hsl(${hue})`}
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {marker !== undefined && marker !== null && markerIndex !== undefined && (
        <circle
          cx={x(markerIndex)}
          cy={y(marker)}
          r="2"
          fill={`hsl(${hue})`}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
