import type { IrNode } from '@infracanvas/ir-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { threeTier } from '../ir/fixtures';
import { evaluateArchitecture } from './evaluate';
import { registerBuiltInResources } from './index';
import { resetResourceRegistry } from './registry';

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

function withDatabase(mutate: (params: Record<string, unknown>) => void) {
  const document = threeTier();
  const database = document.nodes.find((node) => node.kind === 'rds_instance') as IrNode;
  mutate(database.params as Record<string, unknown>);
  return document;
}

describe('evaluating an architecture', () => {
  it('finds nothing to say about a database that follows every rule', () => {
    const document = withDatabase((params) => {
      params.multiAz = true;
      params.publiclyAccessible = false;
      params.deletionProtection = true;
    });

    expect(evaluateArchitecture(document).findings).toEqual([]);
  });

  it('reports a finding against the node it belongs to', () => {
    const document = withDatabase((params) => {
      params.publiclyAccessible = true;
    });

    const { findings } = evaluateArchitecture(document);

    const exposure = findings.find((finding) => finding.ruleId === 'RDS-SEC-001');
    expect(exposure?.pointer.startsWith('rds-')).toBe(true);
    expect(exposure?.pillar).toBe('security');
  });

  it('orders findings by severity so the list reads as a worklist', () => {
    const document = withDatabase((params) => {
      params.multiAz = false;
      params.publiclyAccessible = true;
      params.deletionProtection = false;
    });

    const severities = evaluateArchitecture(document).findings.map((finding) => finding.severity);

    expect(severities).toEqual([...severities].sort());
    expect(severities[0]).toBe('high');
  });

  it('groups findings by pillar and leaves the untouched pillars empty', () => {
    const document = withDatabase((params) => {
      params.multiAz = false;
      params.deletionProtection = false;
    });

    const { byPillar } = evaluateArchitecture(document);

    expect(byPillar.reliability.length).toBeGreaterThan(0);
    expect(byPillar['operational-excellence'].length).toBeGreaterThan(0);
    expect(byPillar.sustainability).toEqual([]);
  });

  it('names the kinds no rule could check rather than passing them silently', () => {
    const { unchecked } = evaluateArchitecture(threeTier());

    // A clean report on an architecture nothing can check is the failure mode
    // this exists to prevent, so every uncontracted kind has to be listed.
    expect(unchecked).toContain('vpc');
    expect(unchecked).toContain('subnet');
    expect(unchecked).not.toContain('rds_instance');
  });

  it('gives a rule the ancestors it needs to see the subnet it sits in', () => {
    const document = withDatabase((params) => {
      params.publiclyAccessible = false;
    });
    const database = document.nodes.find((node) => node.kind === 'rds_instance') as IrNode;
    const subnet = document.nodes.find((node) => node.id === database.parent);
    (subnet!.params as Record<string, unknown>).tier = 'public';

    const { findings } = evaluateArchitecture(document);

    expect(findings.map((finding) => finding.ruleId)).toContain('RDS-SEC-001');
  });

  it('survives a parent reference that points at nothing', () => {
    const document = withDatabase(() => {});
    const database = document.nodes.find((node) => node.kind === 'rds_instance') as IrNode;
    database.parent = 'a-subnet-that-was-deleted';

    expect(() => evaluateArchitecture(document)).not.toThrow();
  });
});
