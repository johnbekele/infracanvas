import { describe, expect, it } from 'vitest';
import { applyJsonPatch, computePatch, patchReproduces } from './json-patch.js';

// Shaped like an IR document but typed loosely on purpose: these tests are about
// the operation algebra, which does not know what an architecture is.
interface TestNode {
  id: string;
  kind: string;
  name: string;
  params: Record<string, unknown>;
}

interface TestDocument extends Record<string, unknown> {
  irVersion: string;
  name: string;
  provider: string;
  region: string;
  nodes: TestNode[];
  edges: unknown[];
}

const parent: TestDocument = {
  irVersion: '1.0.0',
  name: 'Baseline',
  provider: 'aws',
  region: 'ap-southeast-2',
  nodes: [
    { id: 'vpc-main', kind: 'vpc', name: 'Main', params: { cidrBlock: '10.0.0.0/16' } },
    { id: 'db', kind: 'rds_instance', name: 'Postgres', params: { instanceClass: 'db.t4g.small' } },
  ],
  edges: [],
};

describe('computePatch', () => {
  it('describes a changed parameter as a single replace', () => {
    const child = structuredClone(parent);
    child.nodes[1].params.instanceClass = 'db.r6g.large';

    expect(computePatch(parent, child)).toEqual([
      { op: 'replace', path: '/nodes/1/params/instanceClass', value: 'db.r6g.large' },
    ]);
  });

  it('describes an added node', () => {
    const child = structuredClone(parent);
    child.nodes.push({
      id: 'cache',
      kind: 'elasticache_cluster',
      name: 'Cache',
      params: { nodeType: 'cache.t4g.micro' },
    });

    const patch = computePatch(parent, child);

    expect(patch).toHaveLength(1);
    expect(patch[0].op).toBe('add');
    expect(patch[0].path).toBe('/nodes/2');
  });

  it('returns no operations for two identical documents', () => {
    expect(computePatch(parent, structuredClone(parent))).toEqual([]);
  });
});

describe('applyJsonPatch', () => {
  it('reproduces the child document from the parent and the patch', () => {
    const child = structuredClone(parent);
    child.name = 'Aurora Serverless';
    child.nodes[1].kind = 'aurora_cluster';

    expect(applyJsonPatch(parent, computePatch(parent, child))).toEqual(child);
  });

  it('leaves the parent document untouched', () => {
    // The parent is a row we just read and may still compare against, so the
    // patch must not be applied in place.
    const before = structuredClone(parent);

    applyJsonPatch(parent, [{ op: 'replace', path: '/name', value: 'Changed' }]);

    expect(parent).toEqual(before);
  });

  it('throws for an operation whose pointer does not exist', () => {
    expect(() =>
      applyJsonPatch(parent, [{ op: 'replace', path: '/nodes/99/kind', value: 'vpc' }])
    ).toThrow();
  });

  it('refuses an operation that would reach Object.prototype', () => {
    // A patch can arrive from a browser, so a `__proto__` pointer is an attack
    // rather than a mistake and must not be applied.
    expect(() =>
      applyJsonPatch(parent, [{ op: 'add', path: '/__proto__/polluted', value: true }])
    ).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('patchReproduces', () => {
  it('accepts the patch it computed', () => {
    const child = structuredClone(parent);
    child.region = 'eu-central-1';

    expect(patchReproduces(parent, computePatch(parent, child), child)).toBe(true);
  });

  it('rejects a patch that lands on a different document', () => {
    const child = structuredClone(parent);
    child.name = 'Aurora Serverless';

    // A patch the client claims describes its edit, but which changes something
    // else. Accepting it would store a diff the timeline draws wrongly.
    expect(
      patchReproduces(parent, [{ op: 'replace', path: '/name', value: 'Something Else' }], child)
    ).toBe(false);
  });

  it('rejects an unapplicable patch without throwing', () => {
    // The caller is answering a request; a bad operation array is the client's
    // mistake and has to become a 400 rather than a server fault.
    expect(patchReproduces(parent, [{ op: 'remove', path: '/nodes/99' }], parent)).toBe(false);
  });

  it('rejects a patch that leaves the document short of the child', () => {
    const child = structuredClone(parent);
    child.name = 'Aurora Serverless';
    child.region = 'eu-central-1';

    expect(
      patchReproduces(parent, [{ op: 'replace', path: '/name', value: 'Aurora Serverless' }], child)
    ).toBe(false);
  });

  it('accepts an empty patch between identical documents', () => {
    expect(patchReproduces(parent, [], structuredClone(parent))).toBe(true);
  });
});
