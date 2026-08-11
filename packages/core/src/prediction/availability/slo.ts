import { predicted, type Assumption, type Prediction } from '../prediction';
import { MINUTES_PER_MONTH, SLO_LADDER, type AvailabilityReport } from './index';

/**
 * An objective the architecture can actually meet, with the measurement that
 * checks it.
 *
 * The proposal never sits above the modelled availability, because an SLO the
 * architecture cannot hit on a perfect day is a commitment to fail, and a team
 * that misses its target every month stops believing the target rather than
 * fixing the architecture. Each proposal names the CloudWatch metrics that
 * measure it, so the number is checkable rather than aspirational.
 */
export interface SliDefinition {
  name: string;
  description: string;
  /** CloudWatch metric expression for the numerator. */
  goodEvents: string;
  totalEvents: string;
}

export interface SloProposal {
  objective: 'availability' | 'latency';
  target: number;
  unit: 'fraction' | 'ms';
  window: '30d';
  errorBudgetMinutes: number;
  sli: SliDefinition;
  /** Why this rung and not the next one up. */
  rationale: string;
}

/**
 * Deviation from the issue: the contract names `PathLatency`, which the latency
 * model owns and which is being written on another branch. Depending on the
 * single field this file reads keeps the two changes from colliding, and
 * `PathLatency` satisfies it structurally on the day it lands.
 */
export interface PathLatencySummary {
  p95Ms: number;
}

/**
 * A 4xx is a good event. The service answered correctly that the request was
 * wrong, and spending error budget on a client's bug makes a broken caller look
 * like an outage on the dashboard the on-call engineer is paged to.
 */
const AVAILABILITY_SLI: SliDefinition = {
  name: 'request-success-rate',
  description:
    'Requests the load balancer answered without a server error, over all requests it answered. Client errors count as successes.',
  goodEvents:
    'AWS/ApplicationELB RequestCount(Sum) - HTTPCode_ELB_5XX_Count(Sum) - HTTPCode_Target_5XX_Count(Sum)',
  totalEvents: 'AWS/ApplicationELB RequestCount(Sum)',
};

/**
 * The proportion a p95 target admits by definition: one request in twenty is
 * allowed to exceed it, so the budget is a twentieth of the window rather than
 * whatever the availability rung happens to leave.
 */
const LATENCY_TAIL = 0.05;

/**
 * CloudWatch counts responses under a threshold with the trimmed-count
 * statistic, and `TargetResponseTime` is published in seconds, so the target is
 * converted rather than quoted in milliseconds the console would misread.
 */
function latencySli(p95Ms: number): SliDefinition {
  const seconds = p95Ms / 1000;
  return {
    name: 'request-latency',
    description: `Requests the target answered within ${p95Ms} ms, over all requests the load balancer answered.`,
    goodEvents: `AWS/ApplicationELB TargetResponseTime(TC(:${seconds}))`,
    totalEvents: 'AWS/ApplicationELB RequestCount(Sum)',
  };
}

/** Rounded to the tenth of a minute a team would quote in a review. */
function budgetMinutes(unmetFraction: number): number {
  return Math.round(unmetFraction * MINUTES_PER_MONTH * 10) / 10;
}

function asPercent(value: number): string {
  return `${(value * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/**
 * The highest rung at or below the modelled availability, compared without a
 * tolerance. A rung within floating-point noise of the composite is refused
 * rather than admitted, so the guarantee that a proposal is never above the
 * model holds exactly rather than nearly.
 */
function rungFor(compositeAvailability: number): { target: number; next: number | undefined } {
  let target: number | undefined;
  let next: number | undefined;
  for (const rung of SLO_LADDER) {
    if (rung <= compositeAvailability) target = rung;
    else if (next === undefined) next = rung;
  }
  return { target: target ?? Number.NaN, next };
}

/**
 * Deviation from the issue: a third parameter carries the assumptions the
 * report was computed under. `proposeSlos` is handed the report rather than the
 * prediction that wrapped it, so without this the envelope would claim a target
 * derived from the correlation assumption while listing no assumptions at all.
 * The parameter is optional, so the two-argument call in the contract still
 * type-checks.
 */
export function proposeSlos(
  report: AvailabilityReport,
  latency: PathLatencySummary,
  assumptions: readonly Assumption[] = []
): Prediction<SloProposal[]> {
  const proposals: SloProposal[] = [];
  const gaps: string[] = [];

  const { target, next } = rungFor(report.compositeAvailability);
  if (Number.isNaN(target)) {
    gaps.push(
      `No availability objective is proposed: the architecture models at ${asPercent(report.compositeAvailability)}, below the lowest rung of the ladder at 99%, so every target on it would be a commitment to fail.`
    );
  } else {
    proposals.push({
      objective: 'availability',
      target,
      unit: 'fraction',
      window: '30d',
      errorBudgetMinutes: budgetMinutes(1 - target),
      sli: AVAILABILITY_SLI,
      rationale:
        next === undefined
          ? `The architecture models at ${asPercent(report.compositeAvailability)} and the ladder stops at ${asPercent(target)}, so this is the strongest target on it.`
          : `The next rung, ${asPercent(next)}, is above the ${asPercent(report.compositeAvailability)} this architecture models, so committing to it would be a commitment to fail. ${report.weakest === '' ? 'Nothing on the path could be modelled.' : `${report.weakest} is the weakest link on the path.`}`,
    });
  }

  if (latency.p95Ms > 0) {
    proposals.push({
      objective: 'latency',
      target: latency.p95Ms,
      unit: 'ms',
      window: '30d',
      errorBudgetMinutes: budgetMinutes(LATENCY_TAIL),
      sli: latencySli(latency.p95Ms),
      rationale: `The latency model puts the ninety-fifth percentile of the request path at ${latency.p95Ms} ms, so a fifth of an hour a day is already spent above it by construction and the target is set at the figure rather than under it.`,
    });
  } else {
    gaps.push(
      'No latency objective is proposed: the latency model reported no positive ninety-fifth percentile for the request path.'
    );
  }

  if (report.unmodelled.length > 0) {
    gaps.push(
      `${report.unmodelled.length} resource(s) are missing from the availability model, so a target chosen from it may still be above what the architecture can hold: ${report.unmodelled.join(', ')}.`
    );
  }

  return predicted(proposals, [...assumptions], gaps);
}
