import { beforeEach, describe, expect, it } from 'vitest';

import { registerBuiltInResources } from '../resources';
import { resetResourceRegistry } from '../resources/registry';
import { collectFindings, ruleCoverage } from './findings';
import { fourLevelChain, threeTier } from './fixtures';

beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

describe('collectFindings', () => {
  it('raises every rule the registry knows for a document', () => {
    const findings = collectFindings(threeTier());

    // The fixture database is single-AZ, so the reliability rule fires.
    expect(findings.map((finding) => finding.ruleId)).toContain('RDS-REL-001');
  });

  it('points into the document rather than into the node', () => {
    const ir = threeTier();
    const findings = collectFindings(ir);
    const finding = findings.find((candidate) => candidate.ruleId === 'RDS-REL-001');

    const index = ir.nodes.findIndex((node) => node.id === 'rds-primary');
    expect(finding?.pointer).toBe(`/nodes/${index}/params/multiAz`);
  });

  it('gives a rule the ancestors it needs to judge placement', () => {
    const ir = threeTier();
    const database = ir.nodes.find((node) => node.id === 'rds-primary');
    if (database === undefined) throw new Error('the fixture lost its database');
    // Moving the database into the public subnet is a placement decision, not a
    // parameter one, so only a rule that can see its ancestors can catch it.
    database.parent = 'subnet-public-a';

    expect(collectFindings(ir).map((finding) => finding.ruleId)).toContain('RDS-SEC-001');
  });

  it('walks a four-level containment chain without losing the subnet', () => {
    const findings = collectFindings(fourLevelChain());

    // Nothing in that fixture has a contract, so nothing fires, and the walk
    // has to terminate rather than loop.
    expect(findings).toEqual([]);
  });

  it('reports a resource with no contract rather than reporting nothing', () => {
    const coverage = ruleCoverage(threeTier());

    expect(coverage.unruled.map((entry) => entry.resourceId)).toContain('ecs-api');
    expect(coverage.unruled.map((entry) => entry.resourceId)).not.toContain('rds-primary');
  });

  it('resolves a finding when the parameter behind it changes', () => {
    const ir = threeTier();
    const database = ir.nodes.find((node) => node.id === 'rds-primary');
    if (database?.kind !== 'rds_instance') throw new Error('the fixture lost its database');
    database.params.multiAz = true;

    expect(collectFindings(ir).map((finding) => finding.ruleId)).not.toContain('RDS-REL-001');
  });
});
