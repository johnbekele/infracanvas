/**
 * Percentiles are not added. The mean of a path is the sum of the means, which
 * holds by linearity whatever the distributions and whatever the correlations,
 * but the ninety-fifth percentile of a sum is not the sum of the ninety-fifth
 * percentiles: it assumes every resource has its bad day on the same request,
 * which overstates the tail badly on a long path.
 *
 * So the path carries a distribution rather than three numbers, discretised on
 * a shared grid so that a sum is a convolution and a fan-out is a product of
 * the branches' cumulative functions.
 */

/** A power of two, which keeps the bin index arithmetic exact. */
export const GRID_POINTS = 1024;

export interface Grid {
  /** Width of one bin, in milliseconds. */
  stepMs: number;
  points: number;
}

/** Probability mass per bin. Bin `i` covers `[i * stepMs, (i + 1) * stepMs)`. */
export type Distribution = Float64Array;

/** Mass below this is a rounding artefact rather than a percentile anyone reads. */
const NEGLIGIBLE = 1e-15;

/**
 * Where a distribution's tail stops being discretised and is collected into one
 * bin instead. An exponential tail runs to a thousand times the service time
 * before it is arithmetically zero, and convolving those bins costs quadratic
 * time to place a millionth of the mass, which cannot move a percentile this
 * model reports: the last one it offers is the ninety-ninth, ten thousand times
 * further up the distribution.
 */
const TAIL_MASS = 1e-6;

export function gridSpanning(maxMs: number): Grid {
  const span = maxMs > 0 ? maxMs : 1;
  return { stepMs: span / GRID_POINTS, points: GRID_POINTS };
}

/**
 * Mass beyond the grid is folded into the last bin rather than dropped, so the
 * total stays one and a percentile can never be read off a distribution that
 * quietly lost its tail.
 */
export function fromSurvival(survival: (tMs: number) => number, grid: Grid): Distribution {
  const mass = new Float64Array(grid.points);
  const last = grid.points - 1;
  let previous = 1;
  for (let bin = 0; bin < last; bin += 1) {
    const upper = survival((bin + 1) * grid.stepMs);
    if (upper < TAIL_MASS) {
      mass[bin] = previous;
      return mass;
    }
    mass[bin] = Math.max(0, previous - upper);
    previous = upper;
  }
  mass[last] = previous;
  return mass;
}

export function pointMass(tMs: number, grid: Grid): Distribution {
  const mass = new Float64Array(grid.points);
  const bin = Math.min(grid.points - 1, Math.max(0, Math.floor(tMs / grid.stepMs)));
  mass[bin] = 1;
  return mass;
}

/**
 * Direct convolution over the bins each distribution actually occupies rather
 * than over the whole grid. One resource occupies the fraction of the path's
 * grid that its own sojourn time is of the path's, and the collected tail bounds
 * that further, so the quadratic cost is paid on a few hundred bins rather than
 * on a thousand and a Fourier transform is not needed to meet the budget.
 */
export function convolve(a: Distribution, b: Distribution, grid: Grid): Distribution {
  const out = new Float64Array(grid.points);
  const last = grid.points - 1;
  const endA = significantEnd(a);
  const endB = significantEnd(b);

  for (let i = 0; i <= endA; i += 1) {
    const left = a[i] ?? 0;
    if (left < NEGLIGIBLE) continue;
    for (let j = 0; j <= endB; j += 1) {
      const right = b[j] ?? 0;
      if (right < NEGLIGIBLE) continue;
      const bin = i + j;
      out[bin > last ? last : bin] += left * right;
    }
  }
  return out;
}

/**
 * The maximum under independence, which is the product of the branches'
 * cumulative functions. Taking the maximum of the branch percentiles instead
 * would report the slower branch's tail as the fan-out's tail, when in fact
 * either branch being slow is enough to make the request slow.
 */
export function maximumOf(branches: readonly Distribution[], grid: Grid): Distribution {
  const first = branches[0];
  if (first === undefined) return pointMass(0, grid);
  if (branches.length === 1) return first;

  const running = branches.map(() => 0);
  const mass = new Float64Array(grid.points);
  let previous = 0;
  for (let bin = 0; bin < grid.points; bin += 1) {
    let cumulative = 1;
    for (let branch = 0; branch < branches.length; branch += 1) {
      running[branch] = (running[branch] ?? 0) + (branches[branch]?.[bin] ?? 0);
      cumulative *= running[branch] ?? 0;
    }
    mass[bin] = Math.max(0, cumulative - previous);
    previous = cumulative;
  }
  mass[grid.points - 1] += Math.max(0, 1 - previous);
  return mass;
}

export function quantile(distribution: Distribution, q: number, grid: Grid): number {
  if (!(q > 0)) return 0;
  let cumulative = 0;
  for (let bin = 0; bin < grid.points; bin += 1) {
    const mass = distribution[bin] ?? 0;
    if (cumulative + mass >= q) {
      // Interpolated inside the bin, so a percentile moves smoothly with the
      // load rather than in steps the width of the grid.
      const within = mass > 0 ? (q - cumulative) / mass : 0;
      return (bin + within) * grid.stepMs;
    }
    cumulative += mass;
  }
  return grid.points * grid.stepMs;
}

/** The mean of the grid, used where no closed form survives the composition. */
export function meanOf(distribution: Distribution, grid: Grid): number {
  let total = 0;
  for (let bin = 0; bin < grid.points; bin += 1) {
    total += (distribution[bin] ?? 0) * (bin + 0.5) * grid.stepMs;
  }
  return total;
}

function significantEnd(distribution: Distribution): number {
  for (let bin = distribution.length - 1; bin >= 0; bin -= 1) {
    if ((distribution[bin] ?? 0) >= NEGLIGIBLE) return bin;
  }
  return 0;
}
