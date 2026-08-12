import { annualDowntimeMinutes, type ParamsOf, type ReliabilityContribution } from '../contract';

/**
 * The numbers are the Amazon RDS service level agreement, not a measurement:
 * 99.95% monthly uptime for a Multi-AZ DB Instance and 99.5% for a Single-DB
 * Instance, the two commitments AWS makes. They are transcribed again in
 * `prediction/availability/slas.ts` with their source and retrieval date, and
 * a test holds the two statements of them equal.
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
