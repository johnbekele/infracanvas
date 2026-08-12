import type { IrNode } from '@infracanvas/ir-schema';

import { latencyContext, latencyContribution, withArrivalRate } from '../latency';
import type { LatencyContext } from '../latency';
import type { BottleneckContext, ServiceLimit } from '../limits/types';

/**
 * Solving by bisection rather than by algebra.
 *
 * Every limit exposes usage as a function of request rate that never decreases,
 * so the first rate at which usage reaches the limit can be found by halving an
 * interval to within half a request per second in about eighteen steps. Solving
 * each limit analytically would be faster and would have to be redone,
 * correctly, for every new limit form; monotonicity is one property to test per
 * limit, and the solver is then the same code for all of them.
 */

export const RPS_CEILING = 100_000;
export const RPS_TOLERANCE = 0.5;

/** Eighteen steps cover the range at the tolerance; the cap is what stops a badly behaved limit looping. */
export const MAX_BISECTIONS = 40;

/** Little's Law. `residenceSeconds` is W from the latency model. */
export function concurrency(rps: number, residenceSeconds: number): number {
  return rps * residenceSeconds;
}

/**
 * The latency model at a rate the solver chose. Every quota in the table counts
 * things in flight, and a number of things in flight is a request rate times a
 * residence time, so the model already written answers the capacity question
 * without a second one being invented for it.
 */
function latencyAt(ctx: BottleneckContext, rps: number): LatencyContext {
  return withArrivalRate(latencyContext(ctx.assumptions), rps);
}

/** W at this resource, in seconds, waiting included. */
export function residenceSeconds(resource: IrNode, rps: number, ctx: BottleneckContext): number {
  return latencyContribution(resource, latencyAt(ctx, rps)).value.totalMs / 1000;
}

export function utilisationAt(resource: IrNode, rps: number, ctx: BottleneckContext): number {
  return latencyContribution(resource, latencyAt(ctx, rps)).value.utilisation;
}

export function limitValueFor(limit: ServiceLimit, resource: IrNode): number {
  return limit.limitFor === undefined ? limit.value : limit.limitFor(resource);
}

export function limitApplies(limit: ServiceLimit, resource: IrNode): boolean {
  return limit.appliesTo === undefined || limit.appliesTo(resource);
}

/**
 * Lowest rps in [0, RPS_CEILING] where usage reaches the limit, or null when
 * nothing in that range does. Null is the honest answer: an architecture that
 * holds a hundred thousand requests a second is not one this model should name a
 * breaking point for, and extrapolating past the ceiling would be inventing one.
 */
export function solveBreakingRps(
  limit: ServiceLimit,
  resource: IrNode,
  ctx: BottleneckContext
): number | null {
  const value = limitValueFor(limit, resource);
  if (limit.usageAt(resource, RPS_CEILING, ctx) < value) return null;
  if (limit.usageAt(resource, 0, ctx) >= value) return 0;

  let low = 0;
  let high = RPS_CEILING;
  for (let step = 0; step < MAX_BISECTIONS && high - low > RPS_TOLERANCE; step += 1) {
    const middle = (low + high) / 2;
    if (limit.usageAt(resource, middle, ctx) >= value) high = middle;
    else low = middle;
  }
  // The upper end of the bracket, which is a rate known to reach the limit
  // rather than one known not to.
  return high;
}
