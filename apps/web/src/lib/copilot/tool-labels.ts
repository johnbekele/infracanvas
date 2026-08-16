import type { AvailabilityDelta, CostDelta, ToolCallView } from './types';

/**
 * The fallback matters more than the table. An unknown tool renders as its name
 * in a sentence rather than as JSON, so #118 adding a tool degrades to plain
 * English instead of leaking a payload into the UI.
 */
export function describeToolCall(call: ToolCallView): string {
  if (call.summary.trim().length > 0) {
    return call.summary;
  }
  const name = call.tool.replace(/_/g, ' ').trim() || 'tool';
  return `Running ${name}`;
}

/** `+$31.40 / mo`, `-$212.00 / mo`, `no change`, or `at least +$31.40 / mo` when partial. */
export function formatCostDelta(delta: CostDelta): string {
  if (delta.monthlyUsdDelta === 0 && delta.completeness === 'complete') {
    return 'no change';
  }

  const signed = formatSignedUsd(delta.monthlyUsdDelta);
  if (delta.completeness === 'partial') {
    return `at least ${signed} / mo`;
  }
  return `${signed} / mo`;
}

/** `99.95% -> 99.99%`, with `21.6 min -> 4.3 min of monthly downtime`. */
export function formatAvailabilityDelta(delta: AvailabilityDelta): string {
  const beforePct = formatPercent(delta.before);
  const afterPct = formatPercent(delta.after);
  const beforeDown = formatMinutes(delta.downtimeMinutesBefore);
  const afterDown = formatMinutes(delta.downtimeMinutesAfter);
  return `${beforePct} -> ${afterPct}, with ${beforeDown} -> ${afterDown} of monthly downtime`;
}

function formatSignedUsd(value: number): string {
  const abs = Math.abs(value);
  const body = abs.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body.replace('$', '')}`;
  return body;
}

function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  const digits = pct >= 99.9 ? 2 : pct >= 99 ? 2 : 2;
  return `${pct.toFixed(digits)}%`;
}

function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} min`;
}
