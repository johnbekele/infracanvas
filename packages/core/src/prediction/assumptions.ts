import type { ResourceKind } from '@infracanvas/ir-schema';

import { DEFAULT_USAGE, HOURS_PER_MONTH, type UsageAssumptions } from '../resources/contract';
import type { Assumption } from './prediction';

/**
 * Each default is an `Assumption` in its own right rather than a constant
 * inside a formula. A constant buried in a cost function is a number the user
 * cannot argue with; an assumption with a value, a unit and a rationale is one
 * they can disagree with, change, and watch the total move.
 *
 * The values are deliberately ordinary rather than conservative. A small
 * internal service is the shape most first architectures have, and a default
 * chosen to look impressive would make every estimate wrong in the same
 * direction.
 */
export const DEFAULT_ASSUMPTIONS = [
  {
    id: 'time.hoursPerMonth',
    label: 'Hours per month',
    value: HOURS_PER_MONTH,
    unit: 'h',
    source: 'default',
    rationale:
      'A month of continuous operation, 730 hours, which is what an always-on resource bills for. AWS uses the same figure on its own price list.',
  },
  {
    id: 'traffic.requestsPerMonth',
    label: 'Requests per month',
    value: 2_000_000,
    unit: 'requests',
    source: 'default',
    rationale:
      'Roughly one request per second sustained. Low enough that a first deployment is not priced as though it had already succeeded.',
  },
  {
    id: 'traffic.averageResponseKb',
    label: 'Average response size',
    value: 24,
    unit: 'KB',
    source: 'default',
    rationale:
      'A JSON API response with a modest payload. Drives egress and data transfer, which is where an underestimate hurts most.',
  },
  {
    id: 'storage.databaseGb',
    label: 'Database storage',
    value: 20,
    unit: 'GB',
    source: 'default',
    rationale:
      'The smallest allocation worth provisioning on RDS. Overridden by the allocated size on the resource itself where the architecture states one.',
  },
  {
    id: 'storage.objectGb',
    label: 'Object storage',
    value: 50,
    unit: 'GB',
    source: 'default',
    rationale:
      'Application assets, uploads and logs for a small service. Separate from database storage because the two differ by orders of magnitude in practice.',
  },
  {
    id: 'compute.instanceCount',
    label: 'Instances or tasks',
    value: 2,
    unit: 'instances',
    source: 'default',
    rationale:
      'Two, because one is not an architecture that survives an availability zone. Overridden by a desired count on the resource where it carries one.',
  },
  {
    id: 'egress.internetGbPerMonth',
    label: 'Internet egress',
    value: 100,
    unit: 'GB',
    source: 'default',
    rationale:
      'Data leaving AWS to the public internet. The line most often forgotten in a hand-built estimate and the one most likely to surprise.',
  },
  {
    id: 'availability.azCorrelation',
    label: 'Correlated availability zone failure',
    value: 0.1,
    unit: 'fraction',
    source: 'default',
    rationale:
      'The share of failures that take every replica at once, through a control plane problem or a region-wide event. Treating replicas as independent gives a three-zone deployment about eight nines, a figure nobody has ever observed; a tenth is a guess, but it is a guess anyone can change and watch the result move.',
  },
  {
    id: 'traffic.arrivalCv',
    label: 'Burstiness of arrivals',
    value: 1,
    unit: 'coefficient of variation',
    source: 'default',
    rationale:
      'One is the Poisson arrival stream, which is what M/M/c assumes and the only defensible value for traffic nobody has measured. Anything else is a claim about how bursty the load is, and Kingman\u2019s correction applies it the moment a measurement replaces this figure.',
  },
  {
    id: 'service.serviceCv',
    label: 'Variability of service time',
    value: 1,
    unit: 'coefficient of variation',
    source: 'default',
    rationale:
      'One is the exponential service time the queueing model assumes. A cache with a uniform hit path is nearer zero and a service with a slow tail is above one, but both are measurements this model does not have.',
  },
  {
    id: 'service.timeMs.alb',
    label: 'Load balancer service time',
    value: 1.5,
    unit: 'ms',
    source: 'default',
    rationale:
      'Choosing a target and proxying the request, which is the AWS-side portion of TargetResponseTime rather than the target\u2019s own work.',
  },
  {
    id: 'service.timeMs.api_gateway',
    label: 'API Gateway service time',
    value: 3,
    unit: 'ms',
    source: 'default',
    rationale:
      'Authorisation, request mapping and the hop to the integration, excluding the integration itself, which appears as its own resource on the path.',
  },
  {
    id: 'service.timeMs.cloudfront_distribution',
    label: 'CloudFront service time',
    value: 10,
    unit: 'ms',
    source: 'default',
    rationale:
      'Edge processing and the leg to the viewer for a cached object. A miss pays the origin as well, and the origin is a resource of its own on the path rather than a number folded into this one.',
  },
  {
    id: 'service.timeMs.ec2_instance',
    label: 'EC2 application service time',
    value: 40,
    unit: 'ms',
    source: 'default',
    rationale:
      'Application work for one request on a general-purpose instance, excluding whatever it calls. It is the largest default here because application code usually is the largest term.',
  },
  {
    id: 'service.timeMs.ecs_service',
    label: 'ECS task service time',
    value: 40,
    unit: 'ms',
    source: 'default',
    rationale:
      'The same application work as on EC2, because it is the same code in a container. Making the container cheaper would be a claim about the runtime rather than about the request.',
  },
  {
    id: 'service.timeMs.lambda_function',
    label: 'Lambda service time',
    value: 55,
    unit: 'ms',
    source: 'default',
    rationale:
      'A warm invocation: the same application work plus the runtime\u2019s per-invocation overhead. Cold starts are excluded because they are a separate stage rather than a slower average.',
  },
  {
    id: 'service.timeMs.rds_instance',
    label: 'Database service time',
    value: 8,
    unit: 'ms',
    source: 'default',
    rationale:
      'One indexed query returning a small result set from a warm buffer cache. A resource contract that models the query itself replaces this figure.',
  },
  {
    id: 'service.timeMs.elasticache_cluster',
    label: 'Cache service time',
    value: 0.6,
    unit: 'ms',
    source: 'default',
    rationale:
      'An in-memory read plus one network round trip inside the availability zone. Sub-millisecond is the point of the cache, and a default that hid that would hide why it is there.',
  },
  {
    id: 'service.timeMs.dynamodb_table',
    label: 'DynamoDB service time',
    value: 6,
    unit: 'ms',
    source: 'default',
    rationale:
      'A single-item read over HTTPS, which is what the single-digit millisecond figure AWS quotes describes.',
  },
  {
    id: 'service.timeMs.s3_bucket',
    label: 'Object storage service time',
    value: 25,
    unit: 'ms',
    source: 'default',
    rationale:
      'A GET of an object of a few hundred kilobytes, first byte to last. Large objects are bandwidth rather than service time and are not modelled here.',
  },
  {
    id: 'service.timeMs.sqs_queue',
    label: 'Queue service time',
    value: 12,
    unit: 'ms',
    source: 'default',
    rationale:
      'One SendMessage round trip. Time a message spends waiting to be consumed is the consumer\u2019s queue rather than this one, and modelling it here would count the same wait twice.',
  },
  {
    id: 'service.timeMs.nat_gateway',
    label: 'NAT gateway service time',
    value: 0.5,
    unit: 'ms',
    source: 'default',
    rationale:
      'Address translation on the way out of the VPC. Small enough to be invisible on a path and large enough that the connection limit it imposes is worth solving for.',
  },
] as const satisfies readonly Assumption[];

/** Prefix under which a mean service time is registered, one assumption per resource kind. */
export const SERVICE_TIME_PREFIX = 'service.timeMs.';

/** Assumption ids, so a typo in a dependency reference fails to compile. */
export type AssumptionId = (typeof DEFAULT_ASSUMPTIONS)[number]['id'];

export type AssumptionSet = ReadonlyMap<string, Assumption>;

export function defaultAssumptions(): Map<string, Assumption> {
  return new Map(DEFAULT_ASSUMPTIONS.map((assumption) => [assumption.id, { ...assumption }]));
}

/**
 * Overriding records the new value and marks the source, so the panel can show
 * which figures are the user's and which are ours. An unknown id throws rather
 * than being added: a typo that silently creates an assumption nothing reads is
 * a setting that appears to do nothing.
 */
export function withOverride(
  assumptions: AssumptionSet,
  id: string,
  value: number,
  source: 'profile' | 'user' = 'user'
): Map<string, Assumption> {
  const existing = assumptions.get(id);
  if (existing === undefined) throw new UnknownAssumptionError(id);
  const next = new Map(assumptions);
  next.set(id, { ...existing, value, source });
  return next;
}

export class UnknownAssumptionError extends Error {
  constructor(id: string) {
    super(`No assumption is registered under ${id}, so overriding it would change nothing.`);
    this.name = 'UnknownAssumptionError';
  }
}

function valueOf(assumptions: AssumptionSet, id: AssumptionId): number {
  const assumption = assumptions.get(id);
  if (assumption === undefined) throw new UnknownAssumptionError(id);
  return assumption.value;
}

/**
 * Kinds whose storage is the database allocation rather than the object store.
 * The distinction exists because the two assumptions differ by an order of
 * magnitude and feeding one figure to both would make whichever is wrong
 * invisible.
 */
const DATABASE_KINDS: ReadonlySet<string> = new Set([
  'rds_instance',
  'rds_cluster',
  'dynamodb_table',
  'elasticache_cluster',
  'opensearch_domain',
]);

/**
 * Projects the assumption set onto the usage shape a resource contract takes.
 * Contracts see a flat `UsageAssumptions` rather than the assumption set,
 * because a contract that could read any assumption by id would be free to
 * depend on one without anything noticing.
 */
export function usageFor(
  kind: ResourceKind,
  assumptions: AssumptionSet,
  region: string
): UsageAssumptions {
  return {
    hoursPerMonth: valueOf(assumptions, 'time.hoursPerMonth'),
    requestsPerMonth: valueOf(assumptions, 'traffic.requestsPerMonth'),
    averageRequestKb: valueOf(assumptions, 'traffic.averageResponseKb'),
    storageGb: valueOf(
      assumptions,
      DATABASE_KINDS.has(kind) ? 'storage.databaseGb' : 'storage.objectGb'
    ),
    internetEgressGb: valueOf(assumptions, 'egress.internetGbPerMonth'),
    instanceCount: valueOf(assumptions, 'compute.instanceCount'),
    region: region || DEFAULT_USAGE.region,
  };
}

/**
 * The ids `usageFor` can pass through to a contract. Dependency detection
 * probes exactly these, so an assumption absent from this list can never be
 * reported as one a cost line depends on.
 */
export const USAGE_ASSUMPTION_IDS: readonly AssumptionId[] = [
  'time.hoursPerMonth',
  'traffic.requestsPerMonth',
  'traffic.averageResponseKb',
  'storage.databaseGb',
  'storage.objectGb',
  'egress.internetGbPerMonth',
  'compute.instanceCount',
];
