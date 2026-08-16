import snapshot from '../pricing/rds-us-east-1.json';
import {
  usd,
  type CostComponent,
  type CostEstimate,
  type ParamsOf,
  type UsageAssumptions,
} from '../contract';

/**
 * RDS bills two things with different units, instance-hours and provisioned
 * storage gigabyte-months, which is why it is the reference resource: an
 * interface validated against a resource with one usage term would never have
 * needed a breakdown.
 *
 * Multi-AZ is read from the price list's own `Multi-AZ` deployment option
 * rather than doubling the single-AZ rate. The two agree today for these
 * classes, and assuming they always will is how a model quietly becomes wrong
 * in one region.
 */

const PRICE_SOURCE = {
  file: 'packages/core/src/resources/pricing/rds-us-east-1.json',
  priceListVersion: snapshot.priceListVersion,
  capturedAt: snapshot.capturedAt,
} as const;

type Deployment = 'single-az' | 'multi-az';

function deploymentOf(multiAz: boolean | undefined): Deployment {
  return multiAz === true ? 'multi-az' : 'single-az';
}

function instanceRate(
  engine: string,
  instanceClass: string,
  deployment: Deployment
): number | null {
  const byClass = (
    snapshot.instanceHourUsd as Record<string, Record<string, Record<string, number>>>
  )[engine];
  const rate = byClass?.[instanceClass]?.[deployment];
  return typeof rate === 'number' ? rate : null;
}

function storageRate(storageType: string, deployment: Deployment): number | null {
  const rate = (snapshot.storageGbMonthUsd as Record<string, Record<string, number>>)[
    storageType
  ]?.[deployment];
  return typeof rate === 'number' ? rate : null;
}

export function cost(params: ParamsOf<'rds_instance'>, usage: UsageAssumptions): CostEstimate {
  const components: CostComponent[] = [];
  const unpriced: string[] = [];

  if (usage.region !== snapshot.region) {
    // Substituting a neighbouring region's rate would produce a plausible
    // number that is simply wrong, which is worse than an admitted gap.
    return {
      monthlyUsd: 0,
      components: [],
      priceSource: PRICE_SOURCE,
      unpriced: [`region:${usage.region}`],
    };
  }

  const deployment = deploymentOf(params.multiAz);
  const storageType = params.storageType ?? 'gp3';

  const hourly = instanceRate(params.engine, params.instanceClass, deployment);
  if (hourly === null) {
    unpriced.push(`instanceClass:${params.instanceClass}`);
  } else {
    components.push({
      label: `${params.instanceClass} ${params.engine}${deployment === 'multi-az' ? ', Multi-AZ' : ''}`,
      unit: 'instance-hour',
      quantity: usage.hoursPerMonth,
      unitPriceUsd: hourly,
      monthlyUsd: usd(hourly * usage.hoursPerMonth),
    });
  }

  const perGb = storageRate(storageType, deployment);
  if (perGb === null) {
    unpriced.push(`storageType:${storageType}`);
  } else {
    components.push({
      label: `${storageType} storage${deployment === 'multi-az' ? ', Multi-AZ' : ''}`,
      unit: 'gb-month',
      quantity: params.allocatedStorageGb,
      unitPriceUsd: perGb,
      monthlyUsd: usd(perGb * params.allocatedStorageGb),
    });
  }

  // Provisioned IOPS is a third billed dimension, and the IR carries no field
  // to hold the provisioned amount, so it cannot be priced rather than being
  // worth nothing.
  if (storageType === 'io1' || storageType === 'io2') unpriced.push('provisionedIops');

  // Backup storage up to the allocated size is free; beyond it is charged, and
  // how far beyond depends on churn nobody has measured yet.
  if ((params.backupRetentionDays ?? 7) > 0) unpriced.push('backupStorageBeyondAllocated');

  return {
    monthlyUsd: usd(components.reduce((total, component) => total + component.monthlyUsd, 0)),
    components,
    priceSource: PRICE_SOURCE,
    unpriced,
  };
}
