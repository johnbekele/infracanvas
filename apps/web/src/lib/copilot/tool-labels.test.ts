import { describe, expect, it } from 'vitest';

import { describeToolCall, formatAvailabilityDelta, formatCostDelta } from './tool-labels';
import type { AvailabilityDelta, CostDelta } from './types';

function cost(
  partial: Partial<CostDelta> & Pick<CostDelta, 'monthlyUsdDelta' | 'completeness'>
): CostDelta {
  return {
    monthlyUsdBefore: 0,
    monthlyUsdAfter: partial.monthlyUsdDelta,
    byResource: [],
    unpriced: [],
    ...partial,
  };
}

describe('tool-labels', () => {
  it('describes an unknown tool by name rather than by payload', () => {
    expect(
      describeToolCall({
        callId: 'c1',
        tool: 'brand_new_tool',
        summary: '',
      })
    ).toBe('Running brand new tool');
    expect(
      describeToolCall({
        callId: 'c1',
        tool: 'brand_new_tool',
        summary: '',
      })
    ).not.toContain('{');
  });

  it('formats a partial cost delta as a lower bound', () => {
    expect(
      formatCostDelta(
        cost({
          monthlyUsdDelta: 31.4,
          completeness: 'partial',
          unpriced: [
            {
              resourceId: 'cache',
              kind: 'elasticache',
              dimension: 'cost',
              reason: 'no cost model',
              side: 'after',
            },
          ],
        })
      )
    ).toBe('at least +$31.40 / mo');
  });

  it('formats an unchanged cost delta as no change', () => {
    expect(formatCostDelta(cost({ monthlyUsdDelta: 0, completeness: 'complete' }))).toBe(
      'no change'
    );
  });

  it('formats availability as a percentage pair and a downtime pair', () => {
    const delta: AvailabilityDelta = {
      before: 0.9995,
      after: 0.9999,
      delta: 0.0004,
      downtimeMinutesBefore: 21.6,
      downtimeMinutesAfter: 4.3,
      weakestBefore: 'database-primary',
      weakestAfter: 'database-primary',
      completeness: 'complete',
      unmodelled: [],
    };
    expect(formatAvailabilityDelta(delta)).toBe(
      '99.95% -> 99.99%, with 21.6 min -> 4.3 min of monthly downtime'
    );
  });
});
