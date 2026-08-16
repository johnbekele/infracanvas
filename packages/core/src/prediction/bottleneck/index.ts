import type { IrNode } from '@infracanvas/ir-schema';

import { defaultAssumptions, type AssumptionSet } from '../assumptions';
import { arrivalRateFrom, latencyContext, latencyContribution, withArrivalRate } from '../latency';
import { AWS_LIMITS, limitsFor } from '../limits/aws-limits';
import type { BottleneckContext, ServiceLimit } from '../limits/types';
import { predicted, type Assumption, type Prediction } from '../prediction';
import { limitApplies, limitValueFor, RPS_CEILING, solveBreakingRps } from './solve';

/**
 * Which component gives way first, and at what request rate.
 *
 * The latency model says how slow each component is at a given load; this
 * inverts it. Two different things break: capacity, because a queueing resource
 * cannot serve faster than its servers do, and a quota, because Lambda stops at
 * its concurrent executions and a database stops at its connections. Both are
 * expressed as limits over the same solver, so the report ranks them against one
 * another instead of treating the second kind as an afterthought.
 *
 * Where the issue says `Resource` this takes an `IrNode`, which is what an
 * architecture is made of here; the issue was written before the IR landed.
 */

export {
  concurrency,
  limitApplies,
  limitValueFor,
  MAX_BISECTIONS,
  residenceSeconds,
  RPS_CEILING,
  RPS_TOLERANCE,
  solveBreakingRps,
  utilisationAt,
} from './solve';

export { AWS_LIMITS, limitsFor } from '../limits/aws-limits';
export { ANY_SERVICE, type BottleneckContext, type ServiceLimit } from '../limits/types';

export interface Bottleneck {
  resourceId: string;
  limitId: string;
  label: string;
  /** The lowest request rate at which usage reaches the limit. */
  breakingRps: number;
  limitValue: number;
  usageAtTarget: number;
  headroomRps: number;
  adjustable: boolean;
  /** One sentence: raise the quota, add servers, or change the design. */
  remedy: string;
}

export interface BottleneckReport {
  targetRps: number;
  /** Null when nothing breaks below RPS_CEILING; a gap is recorded instead. */
  first: Bottleneck | null;
  /** Ascending by breakingRps. */
  ranked: Bottleneck[];
}

export function bottleneckContext(
  assumptions: AssumptionSet = defaultAssumptions()
): BottleneckContext {
  return {
    assumptions,
    targetRps: arrivalRateFrom(assumptions),
    targetAssumptionIds: ['traffic.requestsPerMonth', 'time.hoursPerMonth'],
  };
}

/** A rate the caller chose, which the traffic assumptions do not stand behind. */
export function withTargetRps(ctx: BottleneckContext, targetRps: number): BottleneckContext {
  return { ...ctx, targetRps, targetAssumptionIds: [] };
}

/**
 * An adjustable quota is usually the cheapest finding in the report: nothing
 * about the architecture is wrong, and asking AWS for more is the whole fix.
 * Saying so is worth more than a generic instruction to redesign, which is what
 * a solver that did not carry the quota code would have to say.
 */
function remedyFor(limit: ServiceLimit, resource: IrNode, breakingRps: number): string {
  const rate = `${Math.round(breakingRps).toLocaleString('en-US')} requests per second`;
  if (limit.adjustable && limit.quotaCode !== null) {
    return `Raise the quota: ${limit.label} is adjustable through Service Quotas as ${limit.quotaCode}, and the architecture holds past ${rate} once it is raised.`;
  }
  if (limit.adjustable) {
    return `Raise the quota: ${limit.label} is adjustable on request, and the architecture holds past ${rate} once it is raised.`;
  }
  if (limit.id === 'queue.capacity') {
    return `Add servers or make ${resource.id} faster: it runs out of serving capacity at ${rate}, and no quota increase changes that.`;
  }
  return `Change the resource: ${limit.label} is fixed for ${resource.id} as configured, so it needs a larger one or the work spread across more of them at ${rate}.`;
}

function bottleneckFor(
  limit: ServiceLimit,
  resource: IrNode,
  ctx: BottleneckContext
): Bottleneck | null {
  if (!limitApplies(limit, resource)) return null;
  const breakingRps = solveBreakingRps(limit, resource, ctx);
  if (breakingRps === null) return null;

  return {
    resourceId: resource.id,
    limitId: limit.id,
    label: limit.label,
    breakingRps,
    limitValue: limitValueFor(limit, resource),
    usageAtTarget: limit.usageAt(resource, ctx.targetRps, ctx),
    headroomRps: breakingRps - ctx.targetRps,
    adjustable: limit.adjustable,
    remedy: remedyFor(limit, resource, breakingRps),
  };
}

/**
 * The assumptions the residence times came from, which are the assumptions the
 * whole report rests on: change a service time and every breaking rate moves.
 */
function assumptionsBehind(architecture: readonly IrNode[], ctx: BottleneckContext): Assumption[] {
  const latency = withArrivalRate(latencyContext(ctx.assumptions), ctx.targetRps);
  const used = architecture.flatMap(
    (resource) => latencyContribution(resource, latency).assumptions
  );
  const target = ctx.targetAssumptionIds
    .map((id) => ctx.assumptions.get(id))
    .filter((assumption): assumption is Assumption => assumption !== undefined);
  return [...used, ...target];
}

export function findBottleneck(
  architecture: readonly IrNode[],
  ctx: BottleneckContext = bottleneckContext()
): Prediction<BottleneckReport> {
  const ranked: Bottleneck[] = [];
  for (const resource of architecture) {
    for (const limit of limitsFor(resource)) {
      const bottleneck = bottleneckFor(limit, resource, ctx);
      if (bottleneck !== null) ranked.push(bottleneck);
    }
  }

  // Ties are broken by resource and limit id so that two runs over the same
  // architecture rank identically, which a report the user compares against
  // yesterday's depends on.
  ranked.sort(
    (a, b) =>
      a.breakingRps - b.breakingRps ||
      (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0) ||
      (a.limitId < b.limitId ? -1 : a.limitId > b.limitId ? 1 : 0)
  );

  const first = ranked[0] ?? null;
  const gaps: string[] = [];
  if (first === null) {
    gaps.push(
      `Nothing in the limit table binds below ${RPS_CEILING.toLocaleString('en-US')} requests per second, so this architecture has no predicted breaking point rather than a high one. ${AWS_LIMITS.length} limits were solved; a resource whose quota is not among them can still be the first to give way.`
    );
  }

  return predicted<BottleneckReport>(
    { targetRps: ctx.targetRps, first, ranked },
    assumptionsBehind(architecture, ctx),
    gaps
  );
}
