import type { LatencyContribution, ParamsOf } from '../contract';

/**
 * What one database round trip adds to a request, not what the database can do
 * under load. Saturation is the bottleneck solver's question; this is the
 * service time a request pays when the instance is not queueing.
 *
 * Multi-AZ raises the tail rather than the median because a commit is
 * acknowledged only once the synchronous standby has the write. The cost falls
 * on writes, and the p95 is where a mixed read-write workload shows it.
 */
const BASE = { p50Ms: 2, p95Ms: 6 };
const MULTI_AZ_COMMIT_MS = { p50Ms: 1, p95Ms: 4 };

/** Burstable classes share a physical core, which widens the tail before any credit exhaustion. */
const BURSTABLE_TAIL_MS = 3;

function isBurstable(instanceClass: string): boolean {
  return /^db\.t\d/.test(instanceClass);
}

export function latency(params: ParamsOf<'rds_instance'>): LatencyContribution {
  const multiAz = params.multiAz === true;
  const burstable = isBurstable(params.instanceClass);

  const p50Ms = BASE.p50Ms + (multiAz ? MULTI_AZ_COMMIT_MS.p50Ms : 0);
  const p95Ms =
    BASE.p95Ms + (multiAz ? MULTI_AZ_COMMIT_MS.p95Ms : 0) + (burstable ? BURSTABLE_TAIL_MS : 0);

  const reasons = [
    `${BASE.p50Ms}ms p50 and ${BASE.p95Ms}ms p95 for a single unqueued query`,
    multiAz
      ? `plus ${MULTI_AZ_COMMIT_MS.p95Ms}ms at p95 for the synchronous standby commit`
      : 'single-AZ, so a commit waits on no standby',
    burstable ? `plus ${BURSTABLE_TAIL_MS}ms at p95 for a shared burstable core` : null,
  ].filter((reason): reason is string => reason !== null);

  return { p50Ms, p95Ms, basis: reasons.join('; ') };
}
