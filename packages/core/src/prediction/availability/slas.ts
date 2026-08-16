/**
 * What AWS has committed to in writing, transcribed rather than remembered.
 *
 * A figure derived from a formula cannot be defended in an incident review; a
 * figure AWS publishes can, which is why every entry carries the page it came
 * from and the day it was read. The retrieval date matters because these
 * numbers move: ElastiCache Multi-AZ was 99.9% until 2023, and RDS made no
 * commitment at all for a Single-DB Instance until January 2024.
 *
 * Every row is one the model can actually select, so a configuration AWS
 * publishes but the IR cannot yet express is absent rather than dead. A service
 * absent from the table is reported as unmodelled rather than assumed
 * available, because an omission that reads as perfect availability is the one
 * error this model must never make.
 */
export interface ServiceSla {
  serviceId: string;
  /** The exact configuration the commitment covers, for example `multi-az`. */
  configuration: string;
  /** Monthly uptime commitment as a fraction, for example 0.9995. */
  monthlyUptime: number;
  scope: 'global' | 'regional' | 'zonal';
  source: string;
  retrievedAt: string;
}

const RETRIEVED_AT = '2026-08-10';

export const AWS_SLAS: readonly ServiceSla[] = [
  {
    serviceId: 'rds',
    configuration: 'multi-az',
    monthlyUptime: 0.9995,
    scope: 'regional',
    source: 'https://aws.amazon.com/rds/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'rds',
    configuration: 'single-az',
    monthlyUptime: 0.995,
    scope: 'zonal',
    source: 'https://aws.amazon.com/rds/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    // The Instance-Level SLA. AWS commits to 99.99% for a fleet spread across
    // zones, but that is a statement about several instances composed, which is
    // the parallel formula's job rather than a row here.
    serviceId: 'ec2',
    configuration: 'single-instance',
    monthlyUptime: 0.995,
    scope: 'zonal',
    source: 'https://aws.amazon.com/compute/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'ecs',
    configuration: 'default',
    monthlyUptime: 0.9999,
    scope: 'regional',
    source: 'https://aws.amazon.com/compute/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'lambda',
    configuration: 'default',
    monthlyUptime: 0.9995,
    scope: 'regional',
    source: 'https://aws.amazon.com/lambda/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'alb',
    configuration: 'multi-az',
    monthlyUptime: 0.9999,
    scope: 'regional',
    source: 'https://aws.amazon.com/elasticloadbalancing/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'nlb',
    configuration: 'multi-az',
    monthlyUptime: 0.9999,
    scope: 'regional',
    source: 'https://aws.amazon.com/elasticloadbalancing/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'api-gateway',
    configuration: 'default',
    monthlyUptime: 0.9995,
    scope: 'regional',
    source: 'https://aws.amazon.com/api-gateway/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 's3',
    configuration: 'standard',
    monthlyUptime: 0.999,
    scope: 'regional',
    source: 'https://aws.amazon.com/s3/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'dynamodb',
    configuration: 'standard',
    monthlyUptime: 0.9999,
    scope: 'regional',
    source: 'https://aws.amazon.com/dynamodb/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'dynamodb',
    configuration: 'global-tables',
    monthlyUptime: 0.99999,
    scope: 'global',
    source: 'https://aws.amazon.com/dynamodb/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'elasticache',
    configuration: 'multi-az',
    monthlyUptime: 0.9999,
    scope: 'regional',
    source: 'https://aws.amazon.com/elasticache/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'elasticache',
    configuration: 'single-az',
    monthlyUptime: 0.995,
    scope: 'zonal',
    source: 'https://aws.amazon.com/elasticache/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    serviceId: 'cloudfront',
    configuration: 'default',
    monthlyUptime: 0.999,
    scope: 'global',
    source: 'https://aws.amazon.com/cloudfront/sla/',
    retrievedAt: RETRIEVED_AT,
  },
  {
    // AWS commits to 100% for Route 53, and the model repeats the commitment
    // rather than discounting it. A hosted zone that never fails contributes
    // nothing to the product, which is the arithmetic saying what the SLA says.
    serviceId: 'route53',
    configuration: 'default',
    monthlyUptime: 1,
    scope: 'global',
    source: 'https://aws.amazon.com/route53/sla/',
    retrievedAt: RETRIEVED_AT,
  },
];

const BY_KEY = new Map(AWS_SLAS.map((sla) => [`${sla.serviceId}\u0000${sla.configuration}`, sla]));

/** Undefined when AWS publishes no commitment for that exact configuration. */
export function findSla(serviceId: string, configuration: string): ServiceSla | undefined {
  return BY_KEY.get(`${serviceId}\u0000${configuration}`);
}
