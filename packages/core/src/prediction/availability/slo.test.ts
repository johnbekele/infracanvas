import { beforeEach, describe, expect, it } from 'vitest';

import { threeTier } from '../../ir/fixtures';
import { registerBuiltInResources } from '../../resources';
import { resetResourceRegistry } from '../../resources/registry';
import { defaultAssumptions } from '../assumptions';
import { availability, MINUTES_PER_MONTH, SLO_LADDER, type AvailabilityReport } from './index';
import { proposeSlos } from './slo';

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

function reportAt(compositeAvailability: number): AvailabilityReport {
  return {
    compositeAvailability,
    downtimeMinutesPerMonth: (1 - compositeAvailability) * MINUTES_PER_MONTH,
    weakest: 'rds-primary',
    nodes: [
      {
        resourceId: 'rds-primary',
        serviceId: 'rds',
        configuration: 'single-az',
        availability: compositeAvailability,
        basis: 'published',
        azCount: 1,
      },
    ],
    unmodelled: [],
  };
}

function availabilityProposal(compositeAvailability: number, p95Ms = 120) {
  return proposeSlos(reportAt(compositeAvailability), { p95Ms }).value.find(
    (proposal) => proposal.objective === 'availability'
  );
}

describe('choosing a target', () => {
  it('never proposes an slo above the modelled availability', () => {
    for (const composite of [0.99, 0.9912, 0.995, 0.9987, 0.9995, 0.99999, 1]) {
      const proposal = availabilityProposal(composite);

      expect(proposal).toBeDefined();
      expect(proposal?.target).toBeLessThanOrEqual(composite);
    }
  });

  it('takes the first rung at or below the model rather than the nearest one', () => {
    expect(availabilityProposal(0.9994)?.target).toBe(0.999);
    expect(availabilityProposal(0.9995)?.target).toBe(0.9995);
    expect(availabilityProposal(0.99949)?.target).toBe(0.999);
  });

  it('caps at the top of the ladder for an architecture above it', () => {
    const proposal = availabilityProposal(0.999999);

    expect(proposal?.target).toBe(SLO_LADDER[SLO_LADDER.length - 1]);
    expect(proposal?.rationale).toContain('the ladder stops at');
  });

  it('proposes no availability objective when even the lowest rung is out of reach', () => {
    const predictionOf = proposeSlos(reportAt(0.97), { p95Ms: 120 });

    expect(predictionOf.value.some((proposal) => proposal.objective === 'availability')).toBe(
      false
    );
    expect(predictionOf.gaps.join()).toContain('below the lowest rung of the ladder at 99%');
  });

  it('names the weakest link when it declines the next rung up', () => {
    const proposal = availabilityProposal(0.9948);

    expect(proposal?.rationale).toContain('The next rung, 99.5%');
    expect(proposal?.rationale).toContain('rds-primary is the weakest link');
  });
});

describe('the error budget', () => {
  it('converts availability to an error budget in minutes over thirty days', () => {
    expect(availabilityProposal(0.999)?.errorBudgetMinutes).toBe(43.2);
    expect(availabilityProposal(0.9999)?.errorBudgetMinutes).toBe(4.3);
    expect(availabilityProposal(0.99)?.errorBudgetMinutes).toBe(432);
    expect(availabilityProposal(0.995)?.errorBudgetMinutes).toBe(216);
  });

  it('measures the budget over the same window an AWS SLA does', () => {
    const proposal = availabilityProposal(0.9995);

    expect(proposal?.window).toBe('30d');
    expect(proposal?.errorBudgetMinutes).toBeCloseTo((1 - 0.9995) * MINUTES_PER_MONTH, 1);
  });

  it('budgets a latency objective at the tail its percentile already admits', () => {
    const latency = proposeSlos(reportAt(0.999), { p95Ms: 250 }).value.find(
      (proposal) => proposal.objective === 'latency'
    );

    expect(latency?.errorBudgetMinutes).toBe(0.05 * MINUTES_PER_MONTH);
  });
});

describe('the indicators', () => {
  it('names real CloudWatch metrics for both a numerator and a denominator', () => {
    const proposals = proposeSlos(reportAt(0.999), { p95Ms: 250 }).value;

    expect(proposals).toHaveLength(2);
    for (const proposal of proposals) {
      expect(proposal.sli.goodEvents).toContain('AWS/ApplicationELB');
      expect(proposal.sli.totalEvents).toBe('AWS/ApplicationELB RequestCount(Sum)');
      expect(proposal.sli.name).not.toBe('');
      expect(proposal.sli.description).not.toBe('');
    }
  });

  it('subtracts only server errors, so a client error is a success', () => {
    const proposal = availabilityProposal(0.999);

    expect(proposal?.sli.goodEvents).toBe(
      'AWS/ApplicationELB RequestCount(Sum) - HTTPCode_ELB_5XX_Count(Sum) - HTTPCode_Target_5XX_Count(Sum)'
    );
    expect(proposal?.sli.goodEvents).not.toContain('4XX');
    expect(proposal?.sli.description).toContain('Client errors count as successes');
  });

  it('expresses the latency threshold in the seconds CloudWatch publishes', () => {
    const latency = proposeSlos(reportAt(0.999), { p95Ms: 250 }).value.find(
      (proposal) => proposal.objective === 'latency'
    );

    expect(latency?.target).toBe(250);
    expect(latency?.unit).toBe('ms');
    expect(latency?.sli.goodEvents).toBe('AWS/ApplicationELB TargetResponseTime(TC(:0.25))');
  });

  it('proposes no latency objective without a percentile to propose it from', () => {
    const predictionOf = proposeSlos(reportAt(0.999), { p95Ms: 0 });

    expect(predictionOf.value.every((proposal) => proposal.objective !== 'latency')).toBe(true);
    expect(predictionOf.gaps.join()).toContain('no positive ninety-fifth percentile');
  });
});

describe('the envelope', () => {
  it('labels every proposal as predicted and carries the assumptions behind it', () => {
    const assumptions = defaultAssumptions();
    const correlation = assumptions.get('availability.azCorrelation');
    if (correlation === undefined) throw new Error('The correlation assumption is not registered.');

    const predictionOf = proposeSlos(reportAt(0.999), { p95Ms: 120 }, [correlation]);

    expect(predictionOf.label).toBe('Predicted');
    expect(predictionOf.assumptions.map((assumption) => assumption.id)).toEqual([
      'availability.azCorrelation',
    ]);
  });

  it('repeats the availability model gaps so a target is not read as safe', () => {
    const report = { ...reportAt(0.999), unmodelled: ['queue-jobs', 'topic-events'] };

    const predictionOf = proposeSlos(report, { p95Ms: 120 });

    expect(predictionOf.gaps.join()).toContain('queue-jobs, topic-events');
    expect(predictionOf.gaps.join()).toContain('2 resource(s) are missing');
  });

  it('proposes an objective the three tier fixture can actually meet', () => {
    const report = availability(threeTier());

    const predictionOf = proposeSlos(report.value, { p95Ms: 95 }, report.assumptions);
    const proposal = predictionOf.value.find((entry) => entry.objective === 'availability');

    expect(proposal?.target).toBe(0.99);
    expect(proposal?.target).toBeLessThanOrEqual(report.value.compositeAvailability);
    expect(proposal?.errorBudgetMinutes).toBe(432);
  });
});
