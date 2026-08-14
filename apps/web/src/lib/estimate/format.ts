/**
 * How figures are worded. A number the reader has to interpret is a number they
 * will interpret wrongly, so availability is shown both as a percentage and as
 * the downtime it allows, and money is never shown to more precision than the
 * model has.
 */

const MINUTES_PER_MONTH = 43_200;

export function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${usd.toFixed(0)}`;
  return `$${(usd / 1000).toFixed(1)}k`;
}

/**
 * To the cent, for anywhere a reader might add the figures up.
 *
 * `money` rounds $13.14 and $2.30 to $13 and $2, which sum to $15 against a
 * $15.44 total. On a card that is a rounding; in a table whose purpose is to
 * let someone check the arithmetic it is a table that does not add up.
 */
export function moneyExact(usd: number): string {
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Nines, to as many decimal places as the figure earns and no more. */
export function percent(fraction: number): string {
  const value = fraction * 100;
  if (value >= 99.999) return `${value.toFixed(4)}%`;
  if (value >= 99.9) return `${value.toFixed(3)}%`;
  if (value >= 99) return `${value.toFixed(2)}%`;
  return `${value.toFixed(1)}%`;
}

/** What an availability figure costs in downtime, which is the part people feel. */
export function downtime(fraction: number): string {
  const minutes = (1 - fraction) * MINUTES_PER_MONTH;
  if (minutes < 1) return `${Math.round(minutes * 60)}s a month`;
  if (minutes < 90) return `${minutes.toFixed(0)} minutes a month`;
  return `${(minutes / 60).toFixed(1)} hours a month`;
}

export function quantity(value: number, unit: string): string {
  const rounded = value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2);
  return `${rounded} ${unit}`;
}

/** Milliseconds below a second, seconds above it, because 1,240ms reads as a mistake. */
export function duration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}\u00b5s`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** A request rate, kept whole because a fractional request per second is noise. */
export function rate(rps: number): string {
  if (rps < 1) return `${rps.toFixed(2)}/s`;
  if (rps < 1000) return `${Math.round(rps).toLocaleString()}/s`;
  return `${(rps / 1000).toFixed(1)}k/s`;
}
