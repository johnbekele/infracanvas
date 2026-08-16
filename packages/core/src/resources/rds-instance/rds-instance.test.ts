import { readFileSync } from 'node:fs';

import type { IrNode } from '@infracanvas/ir-schema';
import { describe, expect, it } from 'vitest';

import { threeTier } from '../../ir/fixtures';
import { DEFAULT_USAGE, EmitReferenceError, type ParamsOf, type RuleContext } from '../contract';
import { cost, emitPulumi, latency, reliability, rules } from './index';

type RdsParams = ParamsOf<'rds_instance'>;

function params(overrides: Partial<RdsParams> = {}): RdsParams {
  return {
    engine: 'postgres',
    engineVersion: '16.4',
    instanceClass: 'db.t3.micro',
    allocatedStorageGb: 20,
    storageType: 'gp3',
    multiAz: false,
    publiclyAccessible: false,
    deletionProtection: false,
    backupRetentionDays: 7,
    storageEncrypted: true,
    ...overrides,
  };
}

function subnet(tier: 'public' | 'private', id = `subnet-${tier}-a`): IrNode {
  return {
    id,
    kind: 'subnet',
    name: `${tier} A`,
    params: { tier, cidrBlock: '10.0.1.0/24', availabilityZone: 'eu-west-1a' },
  };
}

function context(ancestors: IrNode[] = []): RuleContext {
  return { ancestors, region: 'us-east-1' };
}

function findingFor(id: string, rdsParams: RdsParams, ancestors: IrNode[] = []) {
  const rule = rules.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`No rule ${id}.`);
  return rule.evaluate(rdsParams, context(ancestors));
}

describe('cost', () => {
  it('cost components sum to the monthly total', () => {
    const estimate = cost(params(), DEFAULT_USAGE);
    const summed = estimate.components.reduce((total, part) => total + part.monthlyUsd, 0);

    expect(estimate.components.map((part) => part.unit)).toEqual(['instance-hour', 'gb-month']);
    expect(estimate.monthlyUsd).toBeCloseTo(summed, 2);
    expect(estimate.monthlyUsd).toBeGreaterThan(0);
  });

  it('names the price list its numbers came from', () => {
    const { priceSource } = cost(params(), DEFAULT_USAGE);

    expect(priceSource.priceListVersion).toMatch(/^\d{14}$/);
    expect(priceSource.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(priceSource.file).toContain('pricing/rds-us-east-1.json');
  });

  it('charges more for multi az than for single az', () => {
    expect(cost(params({ multiAz: true }), DEFAULT_USAGE).monthlyUsd).toBeGreaterThan(
      cost(params({ multiAz: false }), DEFAULT_USAGE).monthlyUsd
    );
  });

  it('cost reports unpriced parameters rather than assuming they are free', () => {
    // Provisioned IOPS is a third billed dimension the IR has no field for, so
    // it is named rather than counted as nothing.
    expect(cost(params({ storageType: 'io1' }), DEFAULT_USAGE).unpriced).toContain(
      'provisionedIops'
    );
    expect(cost(params({ backupRetentionDays: 7 }), DEFAULT_USAGE).unpriced).toContain(
      'backupStorageBeyondAllocated'
    );
    expect(cost(params({ backupRetentionDays: 0 }), DEFAULT_USAGE).unpriced).not.toContain(
      'backupStorageBeyondAllocated'
    );
  });

  it('reports an instance class the snapshot does not carry instead of pricing it at zero', () => {
    const estimate = cost(params({ instanceClass: 'db.x99.enormous' }), DEFAULT_USAGE);

    expect(estimate.unpriced).toContain('instanceClass:db.x99.enormous');
    expect(estimate.components.map((part) => part.unit)).toEqual(['gb-month']);
  });

  it('refuses to substitute another region rate for one it has no prices for', () => {
    const estimate = cost(params(), { ...DEFAULT_USAGE, region: 'ap-south-1' });

    expect(estimate.monthlyUsd).toBe(0);
    expect(estimate.components).toEqual([]);
    expect(estimate.unpriced).toEqual(['region:ap-south-1']);
  });

  it('scales storage with the allocated size', () => {
    const small = cost(params({ allocatedStorageGb: 20 }), DEFAULT_USAGE);
    const large = cost(params({ allocatedStorageGb: 200 }), DEFAULT_USAGE);
    const storage = (estimate: typeof small) =>
      estimate.components.find((part) => part.unit === 'gb-month')!.monthlyUsd;

    expect(storage(large)).toBeCloseTo(storage(small) * 10, 2);
  });
});

describe('reliability', () => {
  it('multi az raises availability and clears the single point of failure flag', () => {
    const single = reliability(params({ multiAz: false }));
    const multi = reliability(params({ multiAz: true }));

    expect(multi.availability).toBeGreaterThan(single.availability);
    expect(multi.annualDowntimeMinutes).toBeLessThan(single.annualDowntimeMinutes);
    expect(single.singlePointOfFailure).toBe(true);
    expect(multi.singlePointOfFailure).toBe(false);
  });

  it('states downtime in minutes a reader can check against the availability', () => {
    const { availability, annualDowntimeMinutes } = reliability(params({ multiAz: true }));
    expect(annualDowntimeMinutes).toBeCloseTo((1 - availability) * 365.25 * 24 * 60, 0);
  });
});

describe('latency', () => {
  it('multi az raises write latency', () => {
    expect(latency(params({ multiAz: true })).p95Ms).toBeGreaterThan(
      latency(params({ multiAz: false })).p95Ms
    );
  });

  it('explains where each number came from', () => {
    expect(latency(params({ multiAz: true })).basis).toContain('standby');
    expect(latency(params({ multiAz: false })).basis).toContain('no standby');
    expect(latency(params({ instanceClass: 'db.t3.micro' })).basis).toContain('burstable');
    expect(latency(params({ instanceClass: 'db.m5.large' })).basis).not.toContain('burstable');
  });
});

describe('rules', () => {
  it('flags a publicly accessible instance', () => {
    const finding = findingFor('RDS-SEC-001', params({ publiclyAccessible: true }));

    expect(finding).toMatchObject({
      pillar: 'security',
      severity: 'high',
      pointer: '/params/publiclyAccessible',
    });
    expect(finding?.remediation).not.toBe('');
  });

  it('flags an instance placed in a public subnet even when publiclyAccessible is false', () => {
    const finding = findingFor('RDS-SEC-001', params({ publiclyAccessible: false }), [
      subnet('public'),
    ]);

    expect(finding?.ruleId).toBe('RDS-SEC-001');
    expect(finding?.message).toContain('public subnet');
  });

  it('passes a private instance in a private subnet', () => {
    expect(findingFor('RDS-SEC-001', params(), [subnet('private')])).toBeNull();
  });

  it('flags single az and deletion protection separately', () => {
    expect(findingFor('RDS-REL-001', params({ multiAz: false }))?.pillar).toBe('reliability');
    expect(findingFor('RDS-REL-001', params({ multiAz: true }))).toBeNull();
    expect(findingFor('RDS-OPS-001', params({ deletionProtection: false }))?.pillar).toBe(
      'operational-excellence'
    );
    expect(findingFor('RDS-OPS-001', params({ deletionProtection: true }))).toBeNull();
  });

  it('returns a finding rather than throwing when an optional parameter is absent', () => {
    // The rules run over documents a model assembled and over documents a user
    // is halfway through editing, where an optional flag is simply missing.
    const sparse = {
      engine: 'postgres',
      instanceClass: 'db.t3.micro',
      allocatedStorageGb: 20,
    } as RdsParams;

    for (const rule of rules) {
      expect(() => rule.evaluate(sparse, context())).not.toThrow();
    }
    expect(findingFor('RDS-REL-001', sparse)?.ruleId).toBe('RDS-REL-001');
  });

  it('covers three pillars, so one misconfiguration cannot hide behind another', () => {
    expect(new Set(rules.map((rule) => rule.pillar)).size).toBe(rules.length);
  });
});

describe('emit', () => {
  const ancestors: IrNode[] = threeTier()
    .nodes.filter((node) => node.id === 'subnet-private-a' || node.id === 'vpc-main')
    .sort((a) => (a.kind === 'subnet' ? -1 : 1));

  const emitContext = {
    language: 'typescript' as const,
    varName: 'rdsPrimary',
    ancestors,
    region: 'us-east-1',
    refFor(nodeId: string): string {
      const names: Record<string, string> = {
        'subnet-private-a': 'subnetPrivateA',
        'vpc-main': 'vpcMain',
      };
      const name = names[nodeId];
      if (!name) throw new EmitReferenceError(nodeId);
      return name;
    },
  };

  it('emits pulumi matching the golden file', () => {
    const fragment = emitPulumi(threeTierRdsParams(), emitContext);
    const rendered = `${[...fragment.imports, '', ...fragment.statements, '', ...fragment.exports].join('\n')}\n`;
    const golden = readFileSync(new URL('./__golden__/three-tier.rds.ts', import.meta.url), 'utf8');

    expect(rendered).toBe(golden);
  });

  it('throws when refFor is asked for a node the document does not contain', () => {
    expect(() =>
      emitPulumi(threeTierRdsParams(), {
        ...emitContext,
        ancestors: [subnet('private', 'subnet-not-in-the-document')],
      })
    ).toThrow(EmitReferenceError);
  });

  it('refuses to emit an instance with no subnet ancestor', () => {
    expect(() => emitPulumi(threeTierRdsParams(), { ...emitContext, ancestors: [] })).toThrow(
      /no subnet ancestor/
    );
  });
});

function threeTierRdsParams(): RdsParams {
  const node = threeTier().nodes.find((candidate) => candidate.kind === 'rds_instance');
  if (!node || node.kind !== 'rds_instance') throw new Error('The fixture has no RDS instance.');
  return node.params;
}
