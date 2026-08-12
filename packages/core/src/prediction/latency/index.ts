import type { IrNode, ResourceKind } from '@infracanvas/ir-schema';

import { getResourceContract } from '../../resources/registry';
import {
  DEFAULT_ASSUMPTIONS,
  SERVICE_TIME_PREFIX,
  defaultAssumptions,
  type AssumptionSet,
} from '../assumptions';
import { predicted, type Assumption, type Prediction } from '../prediction';
import { composePath, type ComposedSegment, type PathLatency } from './paths';
import { SATURATION_THRESHOLD, solveQueue, type QueueContribution } from './queue';

/**
 * The latency model over an architecture: what each resource contributes at a
 * given load, and what a request path costs end to end.
 *
 * Every input is an assumption or a resource contract. Nothing here measures
 * anything, which is why each figure travels inside a `Prediction` naming the
 * assumptions it moved with.
 */

export {
  erlangC,
  kingmanFactor,
  SATURATION_THRESHOLD,
  sojournPercentile,
  sojournSurvival,
  type QueueContribution,
  type QueueInput,
  type QueueModel,
} from './queue';

export { composePath, type ComposedSegment, type PathLatency } from './paths';

export { GRID_POINTS, type Distribution, type Grid } from './distribution';

/**
 * Mean service times by resource kind.
 *
 * Deviation from the issue, which keys this table by a service id. The IR
 * discriminates resources by `ResourceKind`, so keying by anything else would
 * need a lookup that can fail on the way in. Derived from the assumption list
 * rather than declared beside it, because a table and a set of assumptions
 * holding the same numbers is two places for one figure to be wrong.
 */
export const DEFAULT_SERVICE_TIMES_MS: Readonly<Partial<Record<ResourceKind, number>>> =
  Object.fromEntries(
    DEFAULT_ASSUMPTIONS.filter((assumption) => assumption.id.startsWith(SERVICE_TIME_PREFIX)).map(
      (assumption) => [assumption.id.slice(SERVICE_TIME_PREFIX.length), assumption.value]
    )
  );

/**
 * The account default for Lambda concurrent executions, which is also the
 * number of requests the service will run at once and therefore the server
 * count of the queue. The limit table cites the page it is published on.
 */
export const DEFAULT_LAMBDA_CONCURRENCY = 1000;

/** Assumptions the arrival rate is derived from when the caller does not state one. */
const ARRIVAL_ASSUMPTION_IDS = ['traffic.requestsPerMonth', 'time.hoursPerMonth'] as const;

const SECONDS_PER_HOUR = 3600;

export interface LatencyContext {
  assumptions: AssumptionSet;
  /** lambda offered to the path, in requests per second. */
  arrivalRateRps: number;
  /** Ids the arrival rate came from. Empty when the caller set the rate itself. */
  arrivalAssumptionIds: readonly string[];
}

/**
 * The arrival rate is derived from the traffic assumptions rather than being an
 * assumption of its own, so a user who says how many requests a month the
 * service takes does not have to say it twice in two units and cannot say two
 * different things.
 */
export function arrivalRateFrom(assumptions: AssumptionSet): number {
  const requests = assumptions.get('traffic.requestsPerMonth')?.value ?? 0;
  const hours = assumptions.get('time.hoursPerMonth')?.value ?? 0;
  return hours > 0 ? requests / (hours * SECONDS_PER_HOUR) : 0;
}

export function latencyContext(assumptions: AssumptionSet = defaultAssumptions()): LatencyContext {
  return {
    assumptions,
    arrivalRateRps: arrivalRateFrom(assumptions),
    arrivalAssumptionIds: ARRIVAL_ASSUMPTION_IDS,
  };
}

/**
 * A rate the caller chose, which no assumption stands behind. The bottleneck
 * solver sweeps the rate, and an envelope claiming the traffic assumptions
 * produced a figure the solver invented would be a citation for a number
 * nobody made.
 */
export function withArrivalRate(ctx: LatencyContext, arrivalRateRps: number): LatencyContext {
  return { ...ctx, arrivalRateRps, arrivalAssumptionIds: [] };
}

/**
 * Kinds that carry no service time because a request does not stop at them. A
 * VPC, a subnet, a security group, an IAM role and an ECS cluster are
 * configuration rather than running infrastructure, and an internet gateway is
 * documented as horizontally scaled with no capacity of its own.
 *
 * The list is short and each member earns its place, because it is the one
 * route by which a resource contributes zero without anything being reported.
 */
const NON_SERVING_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  'vpc',
  'subnet',
  'security_group',
  'iam_role',
  'internet_gateway',
  'cloudwatch_log_group',
  'ecs_cluster',
]);

interface Queue {
  queues: boolean;
  servers: number;
}

/**
 * Reading a parameter the schema has not typed yet. Pending kinds carry an
 * untyped bag and typed kinds carry an interface, and the cast is what lets one
 * lookup serve both; a parameter of the wrong type reads as absent rather than
 * as a server count of `true`.
 */
function numberParam(node: IrNode, name: string): number | undefined {
  const value = (node.params as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * How many requests the resource serves at once, which is what makes queueing
 * on it visible. A managed service that AWS scales for the customer has no
 * server count to read and no queue this model can see, so it contributes its
 * service time and nothing else rather than a fabricated utilisation.
 */
function queueFor(node: IrNode, assumptions: AssumptionSet): Queue {
  const fleet = assumptions.get('compute.instanceCount')?.value ?? 1;
  switch (node.kind) {
    case 'ecs_service':
      return { queues: true, servers: numberParam(node, 'desiredCount') ?? fleet };
    case 'ec2_instance':
      return {
        queues: true,
        servers: numberParam(node, 'instanceCount') ?? numberParam(node, 'count') ?? fleet,
      };
    case 'lambda_function':
      return {
        queues: true,
        servers: numberParam(node, 'reservedConcurrency') ?? DEFAULT_LAMBDA_CONCURRENCY,
      };
    case 'rds_instance':
      // One writer. Parallel query execution would raise this, and claiming it
      // without knowing the workload would raise the capacity of every database
      // in every architecture by whatever factor was chosen.
      return { queues: true, servers: 1 };
    case 'elasticache_cluster':
      return { queues: true, servers: numberParam(node, 'numCacheNodes') ?? 1 };
    default:
      return { queues: false, servers: 1 };
  }
}

interface ServiceTime {
  ms: number;
  assumptionIds: string[];
}

/**
 * Median to mean, under the exponential service time the queue assumes. A
 * contract reports the percentiles a user reads; feeding its median to a model
 * that wants a mean would make the two disagree about the same resource by
 * forty per cent.
 */
const MEDIAN_TO_MEAN = 1 / Math.LN2;

/**
 * A measurement beats a model and a model beats a table. The user's own figure
 * is the only one that displaces a resource contract, because a contract that
 * models the resource knows more than a default keyed by kind, and the default
 * exists for the kinds no contract covers yet.
 */
function serviceTimeFor(node: IrNode, ctx: LatencyContext): ServiceTime | null {
  const id = `${SERVICE_TIME_PREFIX}${node.kind}`;
  const assumption = ctx.assumptions.get(id);
  if (assumption !== undefined && assumption.source !== 'default') {
    return { ms: assumption.value, assumptionIds: [id] };
  }

  const contract = getResourceContract(node.kind);
  if (contract !== undefined) {
    // The registry is heterogeneous by construction; the lookup by `node.kind`
    // is what pairs the params with the contract that types them.
    const modelled = contract.latency(node.params as never);
    return { ms: modelled.p50Ms * MEDIAN_TO_MEAN, assumptionIds: [] };
  }

  if (assumption !== undefined) return { ms: assumption.value, assumptionIds: [id] };
  return null;
}

function variabilityOf(assumptions: AssumptionSet): { arrivalCv: number; serviceCv: number } {
  return {
    arrivalCv: assumptions.get('traffic.arrivalCv')?.value ?? 1,
    serviceCv: assumptions.get('service.serviceCv')?.value ?? 1,
  };
}

function assumptionsFor(ids: readonly string[], ctx: LatencyContext): Assumption[] {
  return ids
    .map((id) => ctx.assumptions.get(id))
    .filter((assumption): assumption is Assumption => assumption !== undefined);
}

/**
 * A resource with no service time contributes zero and says so. Contributing
 * zero silently would make a path through an unmodelled resource look faster
 * than the architecture is, which is the one error a latency model must not
 * make.
 */
export function latencyContribution(
  resource: IrNode,
  ctx: LatencyContext
): Prediction<QueueContribution> {
  const serviceTime = serviceTimeFor(resource, ctx);
  if (serviceTime === null) {
    const contribution = solveQueue({
      resourceId: resource.id,
      model: 'fixed',
      servers: 1,
      serviceTimeMs: 0,
      arrivalRateRps: ctx.arrivalRateRps,
      arrivalCv: 1,
      serviceCv: 1,
      assumptionIds: [],
    });
    const gaps = NON_SERVING_KINDS.has(resource.kind)
      ? []
      : [
          `Adds nothing to the path, ${resource.id}: no service time is known for ${resource.kind}, so the path is faster than the architecture is.`,
        ];
    return predicted(contribution, [], gaps);
  }

  const queue = queueFor(resource, ctx.assumptions);
  const { arrivalCv, serviceCv } = variabilityOf(ctx.assumptions);
  const corrected = arrivalCv !== 1 || serviceCv !== 1;

  const ids = [
    ...serviceTime.assumptionIds,
    // A rate and a variability that move nothing on a resource with no queue
    // would be settings the user can change and watch nothing happen.
    ...(queue.queues ? ctx.arrivalAssumptionIds : []),
    ...(queue.queues && corrected ? ['traffic.arrivalCv', 'service.serviceCv'] : []),
  ];

  const contribution = solveQueue({
    resourceId: resource.id,
    model: queue.queues ? 'm/m/c' : 'fixed',
    servers: queue.servers,
    serviceTimeMs: serviceTime.ms,
    arrivalRateRps: ctx.arrivalRateRps,
    arrivalCv,
    serviceCv,
    assumptionIds: ids,
  });

  const gaps = contribution.saturated
    ? [
        `${resource.id} is at ${(contribution.utilisation * 100).toFixed(0)}% utilisation, so its queueing time is held at the ${SATURATION_THRESHOLD * 100}% figure rather than reported; what it needs is capacity, not a percentile.`,
      ]
    : [];

  return predicted(contribution, assumptionsFor(ids, ctx), gaps);
}

/** A step of a request path: one resource, or a fan-out of branches all serving the same request. */
export type PathSegment =
  | { kind: 'resource'; resource: IrNode }
  | { kind: 'fan-out'; branches: IrNode[][] };

/** The common case, where a request visits each resource in turn. */
export function sequentialPath(resources: readonly IrNode[]): PathSegment[] {
  return resources.map((resource) => ({ kind: 'resource', resource }));
}

export function pathLatency(
  path: readonly PathSegment[],
  ctx: LatencyContext
): Prediction<PathLatency> {
  const predictions: Prediction<QueueContribution>[] = [];
  const segments: ComposedSegment[] = path.map((segment) => {
    if (segment.kind === 'resource') {
      const contribution = latencyContribution(segment.resource, ctx);
      predictions.push(contribution);
      return { kind: 'resource', contribution: contribution.value };
    }
    return {
      kind: 'fan-out',
      branches: segment.branches.map((branch) =>
        branch.map((resource) => {
          const contribution = latencyContribution(resource, ctx);
          predictions.push(contribution);
          return contribution.value;
        })
      ),
    };
  });

  return predicted(
    composePath(segments),
    predictions.flatMap((prediction) => prediction.assumptions),
    predictions.flatMap((prediction) => prediction.gaps)
  );
}
