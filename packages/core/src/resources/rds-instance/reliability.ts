import { annualDowntimeMinutes, type ParamsOf, type ReliabilityContribution } from '../contract';

/**
 * The numbers are the Amazon RDS service level agreement, not a measurement:
 * 99.95% monthly uptime for a Multi-AZ instance. AWS publishes no SLA for a
 * Single-AZ instance, so 99.5% is a modelling assumption, chosen because a
 * single instance's planned maintenance and instance replacement alone exceed
 * the Multi-AZ figure. It is stated here so a reader can disagree with it,
 * which is the entire point of putting assumptions in one place.
 */
const MULTI_AZ_AVAILABILITY = 0.9995;
const SINGLE_AZ_AVAILABILITY = 0.995;

export function reliability(params: ParamsOf<'rds_instance'>): ReliabilityContribution {
  const multiAz = params.multiAz === true;
  const availability = multiAz ? MULTI_AZ_AVAILABILITY : SINGLE_AZ_AVAILABILITY;

  return {
    availability,
    annualDowntimeMinutes: annualDowntimeMinutes(availability),
    // A Single-AZ database is the classic single point of failure: nothing else
    // in the architecture holds the data, so its loss is the system's loss.
    singlePointOfFailure: !multiAz,
  };
}
