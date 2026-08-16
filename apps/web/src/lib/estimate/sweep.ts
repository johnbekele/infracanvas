import {
  arrivalRateFrom,
  costArchitecture,
  defaultAssumptions,
  latencyContext,
  pathLatency,
  sequentialPath,
  utilisationAt,
  withArrivalRate,
  withOverride,
  bottleneckContext,
  type ArchitectureIr,
  type AssumptionSet,
  type IrNode,
} from '@infracanvas/core';

/**
 * The architecture at request rates other than the one assumed.
 *
 * A dashboard wants a curve behind each headline figure, and the obvious curve
 * is the last 24 hours. We do not have one: every figure here is predicted from
 * a document, and nothing in the platform has yet observed a request. Drawing a
 * time axis over a prediction would be inventing measurements, which is the one
 * thing this product cannot do and still be worth using.
 *
 * So the axis is load instead of time. That is a real question the models can
 * answer -- what does this design cost, and how does it respond, at twice the
 * traffic -- and it is the more useful one: a flat 24-hour line says the
 * architecture was fine while nothing happened, whereas the point where p95
 * turns upward is the capacity of the design.
 *
 * Every point is computed by the same models as the headline. Nothing is
 * interpolated, smoothed or extrapolated beyond what was sampled.
 */

export interface SweepPoint {
  /** Requests per second the whole architecture was solved at. */
  rps: number;
  /** Multiple of the assumed rate, which is what the axis is labelled with. */
  multiple: number;
  monthlyUsd: number;
  /** Null once the path saturates: a queue past capacity has no finite wait. */
  p95Ms: number | null;
  /** The busiest hop's utilisation, so the curve can show where it turns. */
  peakUtilisation: number;
}

export interface LoadSweep {
  points: SweepPoint[];
  /** The rate the rest of the dashboard reports, marked on every curve. */
  baselineRps: number;
  /** First sampled rate at which some hop is at or past capacity, if any. */
  saturatesAtRps: number | null;
  /**
   * Rate at which the busiest hop reaches capacity, found by bisection. Null
   * when nothing on the path does so below the ceiling the solver sweeps to.
   */
  capacityRps: number | null;
}

/**
 * Enough points to show a bend, few enough to stay interactive. The latency
 * solve is the expensive one and it is a few hundred microseconds per point on
 * a typical document, so this is roughly a tenth of a frame.
 */
const SAMPLES = 24;

/** A hop is at capacity here; past it the queueing formula stops meaning much. */
const SATURATED = 0.98;

/** What counts as "the design has reached its limit" when choosing the range. */
const CAPACITY = 0.95;

/** Matches the bottleneck solver, so both models agree where the axis ends. */
const RPS_CEILING = 100_000;

/** With nothing to saturate, a curve still wants a range. This is an arbitrary one. */
const FALLBACK_MULTIPLE = 10;

/**
 * How far the axis should run.
 *
 * A fixed multiple of the assumed traffic is the obvious choice and the wrong
 * one: a database at two percent utilisation is still at fifteen percent after
 * eight times the load, so the chart is a flat line and the reader learns
 * nothing they did not already have from the headline. The useful range is the
 * one that contains the knee, so the axis is derived from where the design
 * actually runs out -- which is the question the chart is there to answer.
 */
function capacityOf(path: readonly IrNode[], assumptions: AssumptionSet): number | null {
  if (path.length === 0) return null;
  if (peakOf(path, RPS_CEILING, assumptions) < CAPACITY) return null;

  let low = 0;
  let high = RPS_CEILING;
  for (let step = 0; step < 40 && high - low > 0.01; step += 1) {
    const middle = (low + high) / 2;
    if (peakOf(path, middle, assumptions) >= CAPACITY) high = middle;
    else low = middle;
  }
  return high;
}

function rates(baselineRps: number, capacityRps: number | null): number[] {
  // Just past capacity, so the curve visibly turns rather than stopping at the
  // moment it becomes interesting.
  const top = capacityRps === null ? baselineRps * FALLBACK_MULTIPLE : capacityRps * 1.05;

  // The assumed rate is always the first point: the dashboard's headline figure
  // has to sit on the curve, or the two disagree about the same architecture.
  const bottom = Math.min(baselineRps, top / 2);
  if (!(top > bottom)) return [baselineRps];

  const step = Math.log(top / bottom) / (SAMPLES - 1);
  return Array.from({ length: SAMPLES }, (_, index) => bottom * Math.exp(step * index));
}

export function loadSweep(
  document: ArchitectureIr,
  path: readonly string[],
  assumptions: AssumptionSet = defaultAssumptions()
): LoadSweep {
  const baselineRps = arrivalRateFrom(assumptions);
  const byId = new Map<string, IrNode>(document.nodes.map((node) => [node.id, node]));
  const onPath = path
    .map((id) => byId.get(id))
    .filter((node): node is IrNode => node !== undefined);

  const capacityRps = capacityOf(onPath, assumptions);
  const requests = assumptions.get('traffic.requestsPerMonth');
  const points: SweepPoint[] = [];
  let saturatesAtRps: number | null = null;

  for (const rps of rates(baselineRps, capacityRps)) {
    const multiple = baselineRps === 0 ? 1 : rps / baselineRps;

    // Cost scales through the assumption rather than through the rate, because
    // that is the input the cost model actually reads, and going in by the same
    // door as the user's own edit keeps one code path priced.
    const scaled =
      requests === undefined
        ? assumptions
        : withOverride(assumptions, 'traffic.requestsPerMonth', requests.value * multiple);

    const monthlyUsd = costArchitecture(document, {
      region: document.region,
      assumptions: scaled,
    }).value.monthlyUsd;

    const peakUtilisation = peakOf(onPath, rps, assumptions);
    const saturated = peakUtilisation >= SATURATED;
    if (saturated && saturatesAtRps === null) saturatesAtRps = rps;

    points.push({
      rps,
      multiple,
      monthlyUsd,
      p95Ms: saturated ? null : p95At(onPath, rps, assumptions),
      peakUtilisation,
    });
  }

  return { points, baselineRps, saturatesAtRps, capacityRps };
}

function p95At(path: readonly IrNode[], rps: number, assumptions: AssumptionSet): number | null {
  if (path.length === 0) return null;
  const context = withArrivalRate(latencyContext(assumptions), rps);
  return pathLatency(sequentialPath([...path]), context).value.p95Ms;
}

/**
 * The busiest hop at this rate. Utilisation is what decides whether the latency
 * figure beside it means anything, so it is sampled even when the p95 is not.
 */
function peakOf(path: readonly IrNode[], rps: number, assumptions: AssumptionSet): number {
  if (path.length === 0) return 0;
  const context = bottleneckContext(assumptions);
  return path.reduce((peak, node) => Math.max(peak, utilisationAt(node, rps, context)), 0);
}

/** The busiest hop by name at a given rate, for labelling the knee. */
export function busiestAt(
  document: ArchitectureIr,
  path: readonly string[],
  rps: number,
  assumptions: AssumptionSet = defaultAssumptions()
): { resourceId: string; utilisation: number } | null {
  const context = bottleneckContext(assumptions);
  const byId = new Map<string, IrNode>(document.nodes.map((node) => [node.id, node]));

  let worst: { resourceId: string; utilisation: number } | null = null;
  for (const id of path) {
    const node = byId.get(id);
    if (node === undefined) continue;
    const utilisation = utilisationAt(node, rps, context);
    if (worst === null || utilisation > worst.utilisation) {
      worst = { resourceId: id, utilisation };
    }
  }
  return worst;
}
