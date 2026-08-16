import { describe, expect, it } from 'vitest';
import type { ProposedEdge } from '@infracanvas/core';
import { edgeProvenance, provenanceSentence } from './edge-provenance';

function edge(id: string, origin: ProposedEdge['origin']): ProposedEdge {
  return { id, source: `${id}-a`, target: `${id}-b`, origin };
}

describe('edgeProvenance', () => {
  it('counts declared and inferred connections separately', () => {
    const counts = edgeProvenance([
      edge('one', 'declared'),
      edge('two', 'inferred'),
      edge('three', 'inferred'),
    ]);

    expect(counts).toEqual({ declared: 1, inferred: 2 });
  });

  it('counts nothing for a proposal with no connections', () => {
    expect(edgeProvenance([])).toEqual({ declared: 0, inferred: 0 });
  });
});

describe('provenanceSentence', () => {
  it('says how many connections the repository declared', () => {
    const sentence = provenanceSentence({ declared: 3, inferred: 6 });

    expect(sentence).toContain('3 of 9');
    expect(sentence).toContain('solid');
    expect(sentence).toContain('dashed');
  });

  it('says so plainly when the repository declared nothing', () => {
    const sentence = provenanceSentence({ declared: 0, inferred: 4 });

    expect(sentence).toContain('All 4');
    expect(sentence).toContain('inferred');
  });

  it('does not mention inferred connections when there are none', () => {
    const sentence = provenanceSentence({ declared: 2, inferred: 0 });

    expect(sentence).toContain('All 2');
    expect(sentence).not.toContain('dashed');
  });

  it('says nothing about a proposal with no connections', () => {
    expect(provenanceSentence({ declared: 0, inferred: 0 })).toBeNull();
  });
});
