import type { IrNode } from '@infracanvas/ir-schema';

import { kindToServiceId } from '../../ir/kind-map';
import { concurrency, residenceSeconds, utilisationAt } from '../bottleneck/solve';
import { DEFAULT_LAMBDA_CONCURRENCY, SATURATION_THRESHOLD } from '../latency';
import { ANY_SERVICE, type ServiceLimit } from './types';

/**
 * What AWS stops at, transcribed rather than remembered.
 *
 * Quotas usually bind before capacity does, and they are invisible on a diagram,
 * which is exactly why an architecture that looks fine falls over in a load
 * test. Every entry records the page it was read from and the day it was read,
 * because these numbers move.
 *
 * Three limits the issue names are deliberately absent. Tasks per service and
 * targets per target group do not move with the request rate in a model that
 * does not do autoscaling, so neither can ever answer "at what rate does this
 * break". A NAT gateway's connections to one destination would move with the
 * rate, but a connection through a NAT lasts as long as the call it carries
 * rather than as long as the translation, and `usageAt` sees one resource rather
 * than the path; an entry that is knowingly generous is worse than an admitted
 * omission, because it reads as a clean bill of health.
 */

const RETRIEVED_AT = '2026-08-11';

/**
 * Instance memory from the class name, which is how RDS states its connection
 * ceiling. The families differ only in memory per unit of size - burstable and
 * general purpose at eight gigabytes for a `large`, memory optimised at sixteen
 * - so two small tables cover every class the price snapshot carries and every
 * class it is likely to gain.
 */
const MEMORY_GIB_PER_UNIT: Readonly<Record<string, number>> = { t: 8, m: 8, c: 4, r: 16, x: 64 };

const UNITS_BY_SIZE: Readonly<Record<string, number>> = {
  micro: 0.125,
  small: 0.25,
  medium: 0.5,
  large: 1,
  xlarge: 2,
  '2xlarge': 4,
  '4xlarge': 8,
  '8xlarge': 16,
  '12xlarge': 24,
  '16xlarge': 32,
  '24xlarge': 48,
};

const BYTES_PER_GIB = 1024 ** 3;

/** The divisor in the default `max_connections` parameter, which differs by engine. */
const CONNECTION_BYTES: Readonly<Record<string, number>> = {
  postgres: 9_531_392,
  mysql: 12_582_880,
  mariadb: 12_582_880,
};

/** The ceiling the default parameter applies whatever the instance memory works out to. */
const MAX_CONNECTIONS_CEILING = 5000;

function instanceMemoryGib(instanceClass: string): number | null {
  const parsed = /^db\.([a-z])[0-9]+[a-z]*\.(.+)$/.exec(instanceClass);
  const family = parsed?.[1];
  const size = parsed?.[2];
  if (family === undefined || size === undefined) return null;
  const perUnit = MEMORY_GIB_PER_UNIT[family];
  const units = UNITS_BY_SIZE[size];
  if (perUnit === undefined || units === undefined) return null;
  return perUnit * units;
}

function maxConnectionsFor(resource: IrNode): number {
  if (resource.kind !== 'rds_instance') return MAX_CONNECTIONS_CEILING;
  const memoryGib = instanceMemoryGib(resource.params.instanceClass);
  const bytesPerConnection = CONNECTION_BYTES[resource.params.engine];
  // An instance class nothing recognises falls back to the ceiling, which is
  // generous; the serving capacity limit is what keeps the report from calling
  // such a database safe on the strength of it.
  if (memoryGib === null || bytesPerConnection === undefined) return MAX_CONNECTIONS_CEILING;
  return Math.min(
    MAX_CONNECTIONS_CEILING,
    Math.floor((memoryGib * BYTES_PER_GIB) / bytesPerConnection)
  );
}

function isFifo(resource: IrNode): boolean {
  return (resource.params as Record<string, unknown>).fifo === true;
}

export const AWS_LIMITS: readonly ServiceLimit[] = [
  {
    id: 'lambda.concurrentExecutions',
    serviceId: 'lambda',
    label: 'Concurrent executions per region',
    value: DEFAULT_LAMBDA_CONCURRENCY,
    unit: 'executions',
    adjustable: true,
    quotaCode: 'L-B99A9384',
    source: 'https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html',
    retrievedAt: RETRIEVED_AT,
    usageAt: (resource, rps, ctx) => concurrency(rps, residenceSeconds(resource, rps, ctx)),
  },
  {
    id: 'rds.maxConnections',
    serviceId: 'rds',
    label: 'Database connections',
    value: MAX_CONNECTIONS_CEILING,
    unit: 'connections',
    // Raised by editing a parameter group rather than through Service Quotas,
    // and only as far as the instance's memory allows, so the remedy is a
    // larger instance rather than a request to AWS.
    adjustable: false,
    quotaCode: null,
    source:
      'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html#RDS_Limits.MaxConnections',
    retrievedAt: RETRIEVED_AT,
    limitFor: maxConnectionsFor,
    usageAt: (resource, rps, ctx) => concurrency(rps, residenceSeconds(resource, rps, ctx)),
  },
  {
    id: 'elasticache.clientConnections',
    serviceId: 'elasticache',
    label: 'Client connections per node',
    value: 65_000,
    unit: 'connections',
    adjustable: false,
    quotaCode: null,
    source:
      'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Redis.html#ParameterGroups.Redis.Valkey8',
    retrievedAt: RETRIEVED_AT,
    usageAt: (resource, rps, ctx) => concurrency(rps, residenceSeconds(resource, rps, ctx)),
  },
  {
    id: 'sqs.fifoThroughput',
    serviceId: 'sqs',
    label: 'FIFO queue messages per second without batching',
    value: 300,
    unit: 'messages/s',
    adjustable: false,
    quotaCode: null,
    source:
      'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html',
    retrievedAt: RETRIEVED_AT,
    // A standard queue has no such ceiling, and applying this one to it would
    // report a bottleneck that does not exist.
    appliesTo: isFifo,
    usageAt: (_resource, rps) => rps,
  },
  {
    id: 'dynamodb.partitionReadUnits',
    serviceId: 'dynamodb',
    label: 'Read capacity units per partition per second',
    value: 3000,
    unit: 'read units/s',
    adjustable: false,
    quotaCode: null,
    source:
      'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html',
    retrievedAt: RETRIEVED_AT,
    // One strongly consistent read of an item up to four kilobytes per request,
    // all of it landing on one partition, which is the case the limit exists to
    // warn about.
    usageAt: (_resource, rps) => rps,
  },
  {
    id: 'queue.capacity',
    serviceId: ANY_SERVICE,
    label: 'Serving capacity before the queue grows without bound',
    // Imported from the latency model rather than restated, so the rate this
    // solver calls breaking is the rate that model calls saturated.
    value: SATURATION_THRESHOLD,
    unit: 'utilisation',
    adjustable: false,
    quotaCode: null,
    // The one entry AWS does not publish, because it is a property of the
    // queueing model rather than of an account. Citing an AWS page for it would
    // be a citation for something nobody wrote.
    source: 'docs/issues/epic-7-prediction/030-latency-model.md',
    retrievedAt: RETRIEVED_AT,
    usageAt: (resource, rps, ctx) => utilisationAt(resource, rps, ctx),
  },
];

/** The limits that can bind on a resource of this kind, quotas and capacity alike. */
export function limitsFor(resource: IrNode): ServiceLimit[] {
  const serviceId = kindToServiceId(resource.kind);
  return AWS_LIMITS.filter(
    (limit) => limit.serviceId === ANY_SERVICE || limit.serviceId === serviceId
  );
}
