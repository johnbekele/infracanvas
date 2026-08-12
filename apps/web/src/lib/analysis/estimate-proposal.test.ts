import { describe, expect, it } from 'vitest';
import type { ArchitectureProposal } from '@infracanvas/core';

import { summariseProposal } from './estimate-proposal';

function proposal(nodes: ArchitectureProposal['nodes']): ArchitectureProposal {
  return { name: 'ledger architecture', nodes, edges: [], decisions: [], gaps: [] };
}

const database: ArchitectureProposal['nodes'][number] = {
  id: 'database-primary',
  serviceId: 'rds',
  position: { x: 0, y: 0 },
  properties: { engine: 'postgres', instanceClass: 'db.t3.micro', allocatedStorage: 20 },
  evidence: ['docker-compose.yml'],
  confidence: 'high',
};

const vpc: ArchitectureProposal['nodes'][number] = {
  id: 'network',
  serviceId: 'vpc-environment',
  position: { x: 0, y: 0 },
  properties: { cidrBlock: '10.0.0.0/16' },
  evidence: [],
  confidence: 'medium',
};

describe('summarising a proposal for a card', () => {
  it('prices the proposal the same way the estimate panel would', () => {
    const summary = summariseProposal(proposal([database]));

    expect(summary?.monthlyUsd).toBeGreaterThan(0);
    expect(summary?.serviceCount).toBe(1);
  });

  it('counts what carries no price, so a small total can be read correctly', () => {
    // A VPC is drawn and not billed for. Reporting it as free would make an
    // architecture look cheaper the more of it the models cannot yet price.
    const summary = summariseProposal(proposal([vpc, database]));

    expect(summary?.unpricedCount).toBeGreaterThan(0);
  });

  it('reports the Well-Architected findings a single zone database earns', () => {
    const summary = summariseProposal(proposal([database]));

    // Not zero, because a database in one availability zone is worth saying
    // something about, and not high severity, because it is a decision rather
    // than a mistake. The card words those two cases differently.
    expect(summary?.findings).toBeGreaterThan(0);
    expect(summary?.highSeverity).toBe(0);
  });

  it('counts a publicly reachable database as something to fix before deploying', () => {
    const summary = summariseProposal(
      proposal([{ ...database, properties: { ...database.properties, publiclyAccessible: true } }])
    );

    expect(summary?.highSeverity).toBeGreaterThan(0);
  });

  it('has nothing to say about a repository with no proposal', () => {
    expect(summariseProposal(null)).toBeNull();
    expect(summariseProposal(proposal([]))).toBeNull();
  });

  it('omits the figures rather than failing the page on a proposal it cannot read', () => {
    const broken = proposal([
      { ...database, serviceId: 'not-a-service-in-the-catalogue' },
    ]) as ArchitectureProposal;

    expect(() => summariseProposal(broken)).not.toThrow();
  });
});
