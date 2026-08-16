import { describe, expect, it } from 'vitest';

import { IR_VERSION, type ArchitectureIr, type IrNode } from '@infracanvas/ir-schema';

import { irDigest } from './digest';
import { fixture, patchFixture, patchFixtureNames, threeTier } from './fixtures';
import {
  applyPatch,
  invertPatch,
  IR_PATCH_VERSION,
  IrPatchError,
  MAX_OPS_PER_PATCH,
  type IrPatch,
  type IrPatchOp,
} from './patch';

function patchOf(ir: ArchitectureIr, ops: IrPatchOp[], summary = 'A change'): IrPatch {
  return { patchVersion: IR_PATCH_VERSION, basedOnIrDigest: irDigest(ir), summary, ops };
}

function paramOf(ir: ArchitectureIr, nodeId: string, param: string): unknown {
  const node = ir.nodes.find((candidate) => candidate.id === nodeId);
  return (node?.params as Record<string, unknown> | undefined)?.[param];
}

describe('applyPatch', () => {
  it('applies a set_param patch and leaves the input document untouched', () => {
    const ir = threeTier();
    const before = structuredClone(ir);
    const nodesBefore = ir.nodes;

    const result = applyPatch(
      ir,
      patchOf(ir, [{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true }])
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(paramOf(result.ir, 'rds-primary', 'multiAz')).toBe(true);
    expect(result.touchedNodeIds).toEqual(['rds-primary']);

    // Reference identity as well as value: a caller holding the pre-patch
    // document must be able to keep holding it while a proposal is open.
    expect(ir.nodes).toBe(nodesBefore);
    expect(ir).toEqual(before);
  });

  it('rejects the whole patch when one operation fails a precondition', () => {
    const ir = threeTier();
    const before = structuredClone(ir);

    const result = applyPatch(
      ir,
      patchOf(ir, [
        { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true },
        { op: 'remove_edge', edgeId: 'no-such-edge' },
        { op: 'set_param', nodeId: 'rds-primary', param: 'backupRetentionDays', value: 30 },
      ])
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ opIndex: 1, source: 'precondition' });
    // The first operation was applied to the working copy and thrown away with it.
    expect(ir).toEqual(before);
  });

  it('rejects the whole patch when the result would fail validateIr', () => {
    const ir = threeTier();

    const result = applyPatch(
      ir,
      patchOf(ir, [{ op: 'set_param', nodeId: 'vpc-main', param: 'cidrBlock', value: '10.0.0/16' }])
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toMatchObject({ opIndex: -1, source: 'schema' });
    expect(result.problems[0].pointer).toContain('cidrBlock');
  });

  it('removes edges and then the node they referenced in one patch', () => {
    const ir = threeTier();

    const result = applyPatch(
      ir,
      patchOf(ir, [
        { op: 'remove_edge', edgeId: 'api-to-db' },
        { op: 'remove_node', nodeId: 'rds-primary' },
      ])
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.nodes.map((node) => node.id)).not.toContain('rds-primary');
    expect(result.ir.edges.map((edge) => edge.id)).not.toContain('api-to-db');
    // The edge names both of its ends, so removing it touches the service too.
    expect(result.touchedNodeIds).toEqual(['ecs-api', 'rds-primary']);
  });

  it('refuses to remove a node an edge still references', () => {
    const ir = threeTier();

    const result = applyPatch(ir, patchOf(ir, [{ op: 'remove_node', nodeId: 'rds-primary' }]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0].source).toBe('precondition');
    expect(result.problems[0].message).toContain('api-to-db');
  });

  it('refuses to remove a node another node still sits inside', () => {
    const ir = threeTier();

    const result = applyPatch(ir, patchOf(ir, [{ op: 'remove_node', nodeId: 'subnet-private-a' }]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0].source).toBe('precondition');
    expect(result.problems[0].message).toMatch(/ecs-api|rds-primary/);
  });

  it('refuses a patch computed against a different document', () => {
    const ir = threeTier();
    const patch = patchOf(fixture('minimal'), [
      { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true },
    ]);

    const result = applyPatch(ir, patch);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([expect.objectContaining({ opIndex: -1, source: 'patch' })]);
    expect(result.problems[0].message).toContain('was computed against document');
  });

  it('rejects a patch longer than the operation ceiling', () => {
    const ir = threeTier();
    const ops: IrPatchOp[] = Array.from({ length: MAX_OPS_PER_PATCH + 1 }, (_, index) => ({
      op: 'set_param',
      nodeId: 'rds-primary',
      param: `probe${index}`,
      value: index,
    }));

    const result = applyPatch(ir, patchOf(ir, ops));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0].opIndex).toBe(-1);
    expect(result.problems[0].message).toContain(String(MAX_OPS_PER_PATCH));
  });

  it('refuses a move that would make a node its own ancestor', () => {
    const ir = threeTier();

    const result = applyPatch(
      ir,
      patchOf(ir, [{ op: 'move_node', nodeId: 'vpc-main', parent: 'subnet-private-a' }])
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0].source).toBe('precondition');
    expect(result.problems[0].message).toContain('its own ancestor');
  });

  it('refuses an operation it does not recognise rather than skipping it', () => {
    const ir = threeTier();
    const ops = [{ op: 'rename_node', nodeId: 'rds-primary' }] as unknown as IrPatchOp[];

    const result = applyPatch(ir, patchOf(ir, ops));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toMatchObject({ opIndex: 0, source: 'patch' });
  });

  it('refuses a patch written for another version of the protocol', () => {
    const ir = threeTier();
    const patch = { ...patchOf(ir, []), patchVersion: 2 } as unknown as IrPatch;

    const result = applyPatch(ir, patch);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0].message).toContain('patch version');
  });

  it('accepts an empty operation list, which is how a caller asks about today', () => {
    const ir = threeTier();

    const result = applyPatch(ir, patchOf(ir, []));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(irDigest(result.ir)).toBe(irDigest(ir));
    expect(result.touchedNodeIds).toEqual([]);
  });

  it('replaces a kind wholesale rather than merging the old parameters', () => {
    const ir = threeTier();

    const result = applyPatch(
      ir,
      patchOf(ir, [
        {
          op: 'replace_kind',
          nodeId: 'ecs-api',
          kind: 'lambda_function',
          params: { runtime: 'nodejs20.x', memoryMb: 512 },
        },
      ])
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.ir.nodes.find((candidate) => candidate.id === 'ecs-api');
    expect(node?.kind).toBe('lambda_function');
    expect(node?.params).toEqual({ runtime: 'nodejs20.x', memoryMb: 512 });
    // Identity and placement survive; only the kind and its parameters change.
    expect(node?.name).toBe('API service');
    expect(node?.parent).toBe('subnet-private-a');
  });
});

describe('invertPatch', () => {
  it('clears an optional parameter with null and restores it on inversion', () => {
    const ir = threeTier();
    expect(paramOf(ir, 'rds-primary', 'backupRetentionDays')).toBe(7);

    const patch = patchOf(ir, [
      { op: 'set_param', nodeId: 'rds-primary', param: 'backupRetentionDays', value: null },
    ]);
    const forward = applyPatch(ir, patch);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(paramOf(forward.ir, 'rds-primary', 'backupRetentionDays')).toBeUndefined();

    const inverse = invertPatch(ir, patch);
    expect(inverse.ops).toEqual([
      { op: 'set_param', nodeId: 'rds-primary', param: 'backupRetentionDays', value: 7 },
    ]);

    const back = applyPatch(forward.ir, inverse);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(irDigest(back.ir)).toBe(irDigest(ir));
  });

  it('restores a parameter that was absent by clearing it again', () => {
    const ir = threeTier();
    const patch = patchOf(ir, [
      { op: 'set_param', nodeId: 'ecs-api', param: 'desiredCount', value: 6 },
      { op: 'set_param', nodeId: 'ecs-api', param: 'placementStrategy', value: 'spread' },
    ]);
    const forward = applyPatch(ir, patch);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;

    const inverse = invertPatch(ir, patch);
    expect(inverse.ops[0]).toEqual({
      op: 'set_param',
      nodeId: 'ecs-api',
      param: 'placementStrategy',
      value: null,
    });

    const back = applyPatch(forward.ir, inverse);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(irDigest(back.ir)).toBe(irDigest(ir));
  });

  it('inverts every fixture patch back to the original digest', () => {
    for (const name of patchFixtureNames()) {
      const { ir, patch } = patchFixture(name);
      const forward = applyPatch(ir, patch);
      expect(forward.ok, `${name} should apply`).toBe(true);
      if (!forward.ok) continue;

      const inverse = invertPatch(ir, patch);
      expect(inverse.basedOnIrDigest, `${name} inverse is based on the patched document`).toBe(
        irDigest(forward.ir)
      );

      const back = applyPatch(forward.ir, inverse);
      expect(back.ok, `${name} inverse should apply`).toBe(true);
      if (!back.ok) continue;
      expect(irDigest(back.ir), `${name} round trips`).toBe(irDigest(ir));
    }
  });

  it('refuses every fixture the document does not permit, for the stated reason', () => {
    for (const name of patchFixtureNames('invalid/')) {
      const { ir, patch, expect: expectation } = patchFixture(name);
      expect(expectation, `${name} states how it is refused`).toBeDefined();
      if (!expectation) continue;

      const result = applyPatch(ir, patch);
      expect(result.ok, `${name} should be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.problems[0], name).toMatchObject({
        opIndex: expectation.opIndex,
        source: expectation.source,
      });
    }
  });

  it('throws rather than inverting against the wrong pre-image', () => {
    const ir = threeTier();
    const patch = patchOf(fixture('minimal'), [{ op: 'remove_node', nodeId: 'rds-primary' }]);

    expect(() => invertPatch(ir, patch)).toThrow(IrPatchError);
  });

  it('unwinds a multi-operation patch in the order that restores each state', () => {
    const ir = threeTier();
    const cache: IrNode = {
      id: 'cache-sessions',
      kind: 'elasticache_cluster',
      name: 'Session cache',
      parent: 'subnet-private-a',
      layout: { x: 432, y: 48 },
      params: { engine: 'redis', nodeType: 'cache.t4g.micro' },
    };
    const patch = patchOf(ir, [
      { op: 'add_node', node: cache },
      {
        op: 'add_edge',
        edge: { id: 'api-to-cache', kind: 'connects', source: 'ecs-api', target: 'cache-sessions' },
      },
    ]);

    const forward = applyPatch(ir, patch);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;

    const inverse = invertPatch(ir, patch);
    // The edge has to go before the node it points at, which is the whole
    // reason the inverse is the reversed sequence rather than the same one.
    expect(inverse.ops.map((op) => op.op)).toEqual(['remove_edge', 'remove_node']);

    const back = applyPatch(forward.ir, inverse);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(irDigest(back.ir)).toBe(irDigest(ir));
  });
});

describe('performance', () => {
  function largeDocument(nodes: number): ArchitectureIr {
    const document: ArchitectureIr = {
      irVersion: IR_VERSION,
      name: 'Large architecture',
      provider: 'aws',
      region: 'eu-west-1',
      nodes: [
        {
          id: 'vpc-main',
          kind: 'vpc',
          name: 'Main VPC',
          layout: { x: 0, y: 0 },
          params: { cidrBlock: '10.0.0.0/16' },
        },
      ],
      edges: [],
      presentation: { viewport: { x: 0, y: 0, zoom: 1 } },
    };

    for (let index = 1; index < nodes; index += 1) {
      document.nodes.push({
        id: `svc-${index}`,
        kind: 'sqs_queue',
        name: `Queue ${index}`,
        parent: 'vpc-main',
        layout: { x: index * 8, y: index * 4 },
        params: { visibilityTimeoutSeconds: 30 },
      });
    }
    return document;
  }

  function median(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  it('applies and inverts a twenty-operation patch against a five-hundred-node document', () => {
    const ir = largeDocument(500);
    const ops: IrPatchOp[] = Array.from({ length: 20 }, (_, index) => ({
      op: 'set_param',
      nodeId: `svc-${index + 1}`,
      param: 'visibilityTimeoutSeconds',
      value: 60,
    }));
    const patch = patchOf(ir, ops);

    for (let run = 0; run < 5; run += 1) expect(applyPatch(ir, patch).ok).toBe(true);

    const applied: number[] = [];
    const inverted: number[] = [];
    const digested: number[] = [];
    for (let run = 0; run < 21; run += 1) {
      let started = performance.now();
      applyPatch(ir, patch);
      applied.push(performance.now() - started);

      started = performance.now();
      invertPatch(ir, patch);
      inverted.push(performance.now() - started);

      started = performance.now();
      irDigest(ir);
      digested.push(performance.now() - started);
    }

    // Measured on a development machine: apply 2.6ms, of which `validateIr`
    // carries its own budget; invert 3.8ms, which is the replay plus the digest
    // of the patched document its contract requires; digest 1.6ms.
    //
    // The budgets are an order of magnitude above those figures, because CI runs
    // every package's suite concurrently on a small runner where the process
    // spends most of the interval descheduled (#152). They catch a quadratic
    // walk or a per-call schema compilation, not a few per cent.
    expect(median(applied)).toBeLessThan(80);
    expect(median(inverted)).toBeLessThan(40);
    expect(median(digested)).toBeLessThan(60);
  });
});
