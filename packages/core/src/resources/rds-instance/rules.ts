import type { IrNode } from '@infracanvas/ir-schema';

import type { ParamsOf, RuleContext, WellArchitectedRule } from '../contract';

/**
 * Three rules across three pillars, each checkable from parameters the IR
 * already carries. A rule returns null when it passes and never throws: it runs
 * over documents assembled by a model and by a user mid-edit, and an exception
 * there would take out the whole findings panel rather than one line of it.
 */

function nearestSubnet(ancestors: IrNode[]): Extract<IrNode, { kind: 'subnet' }> | undefined {
  return ancestors.find(
    (node): node is Extract<IrNode, { kind: 'subnet' }> => node.kind === 'subnet'
  );
}

const publicExposure: WellArchitectedRule<'rds_instance'> = {
  id: 'RDS-SEC-001',
  pillar: 'security',
  severity: 'high',
  evaluate(params: ParamsOf<'rds_instance'>, context: RuleContext) {
    const subnet = nearestSubnet(context.ancestors);
    const inPublicSubnet = subnet?.params.tier === 'public';
    if (params.publiclyAccessible !== true && !inPublicSubnet) return null;

    return {
      ruleId: 'RDS-SEC-001',
      pillar: 'security',
      severity: 'high',
      message:
        params.publiclyAccessible === true
          ? 'The database is reachable from the internet.'
          : `The database sits in the public subnet ${subnet?.name}, so its instance can be given a public address.`,
      // The pointer names the parameter a user can act on, which is the flag
      // even when the finding came from the placement.
      pointer: '/params/publiclyAccessible',
      remediation:
        'Place the instance in a private subnet and reach it through the application tier or a bastion.',
    };
  },
};

const singleAz: WellArchitectedRule<'rds_instance'> = {
  id: 'RDS-REL-001',
  pillar: 'reliability',
  severity: 'medium',
  evaluate(params: ParamsOf<'rds_instance'>) {
    if (params.multiAz === true) return null;

    return {
      ruleId: 'RDS-REL-001',
      pillar: 'reliability',
      severity: 'medium',
      message:
        'The database runs in one availability zone, so losing that zone loses the data tier.',
      pointer: '/params/multiAz',
      remediation:
        'Enable Multi-AZ for a synchronous standby with automatic failover. It roughly doubles the instance and storage cost.',
    };
  },
};

const deletionProtection: WellArchitectedRule<'rds_instance'> = {
  id: 'RDS-OPS-001',
  pillar: 'operational-excellence',
  severity: 'medium',
  evaluate(params: ParamsOf<'rds_instance'>) {
    if (params.deletionProtection === true) return null;

    return {
      ruleId: 'RDS-OPS-001',
      pillar: 'operational-excellence',
      severity: 'medium',
      message: 'Deletion protection is off, so a single stack operation can destroy the database.',
      pointer: '/params/deletionProtection',
      remediation:
        'Enable deletion protection outside experiments. An experiment that is meant to be destroyed should leave it off deliberately.',
    };
  },
};

export const rules: WellArchitectedRule<'rds_instance'>[] = [
  publicExposure,
  singleAz,
  deletionProtection,
];
