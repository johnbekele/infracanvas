import { describe, expect, it } from 'vitest';
import type { ArchitectureProposal } from '@infracanvas/core';
import { proposalToFlow } from './to-flow';

function proposalWith(edges: ArchitectureProposal['edges']): ArchitectureProposal {
  return {
    name: 'ledger architecture',
    nodes: [
      {
        id: 'compute-api',
        serviceId: 'ecs',
        position: { x: 0, y: 0 },
        properties: {},
        evidence: ['apps/api/Dockerfile'],
        confidence: 'high',
      },
      {
        id: 'database-primary',
        serviceId: 'rds',
        position: { x: 200, y: 0 },
        properties: {},
        evidence: ['docker-compose.yml'],
        confidence: 'high',
      },
    ],
    edges,
    decisions: [],
    gaps: [],
  };
}

describe('proposalToFlow', () => {
  it('draws a declared connection solid', () => {
    const { edges } = proposalToFlow(
      proposalWith([
        {
          id: 'edge-declared',
          source: 'compute-api',
          target: 'database-primary',
          label: 'depends_on',
          origin: 'declared',
        },
      ])
    );

    expect(edges[0].style).toBeUndefined();
    expect(edges[0].data).toEqual({ origin: 'declared' });
  });

  it('draws an inferred connection dashed', () => {
    // The dash is what tells a reviewer the engine guessed this, and is the only
    // signal on the canvas itself.
    const { edges } = proposalToFlow(
      proposalWith([
        {
          id: 'edge-inferred',
          source: 'compute-api',
          target: 'database-primary',
          label: 'postgres',
          origin: 'inferred',
        },
      ])
    );

    expect(edges[0].style?.strokeDasharray).toBe('6 4');
    expect(edges[0].data).toEqual({ origin: 'inferred' });
  });

  it('drops an edge whose end was not drawn', () => {
    const { edges } = proposalToFlow(
      proposalWith([
        {
          id: 'edge-dangling',
          source: 'compute-api',
          target: 'never-placed',
          origin: 'inferred',
        },
      ])
    );

    expect(edges).toEqual([]);
  });
});
