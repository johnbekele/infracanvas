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
] as const satisfies readonly Assumption[];

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
