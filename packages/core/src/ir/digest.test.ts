import { describe, expect, it } from 'vitest';

import { canonicalJson, irDigest, patchDigest } from './digest';
import { threeTier } from './fixtures';
import { IR_PATCH_VERSION, type IrPatch } from './patch';

function patchOf(ops: IrPatch['ops'], summary: string): IrPatch {
  return { patchVersion: IR_PATCH_VERSION, basedOnIrDigest: 'a'.repeat(64), summary, ops };
}

describe('canonicalJson', () => {
  it('orders keys, so two documents written in different orders encode identically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it('keeps array order, which is meaningful, and drops undefined, which is not', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('irDigest', () => {
  it('ignores layout and viewport when digesting a document', () => {
    const ir = threeTier();
    const before = irDigest(ir);

    ir.nodes[0].layout = { x: 4000, y: -320, width: 12, height: 12 };
    delete ir.nodes[1].layout;
    ir.presentation = { viewport: { x: 91, y: -4, zoom: 3.5 } };

    expect(irDigest(ir)).toBe(before);
  });

  it('changes when any parameter changes', () => {
    const ir = threeTier();
    const before = irDigest(ir);

    const database = ir.nodes.find((node) => node.id === 'rds-primary');
    if (database?.kind !== 'rds_instance') throw new Error('fixture lost its database');
    database.params.multiAz = true;

    expect(irDigest(ir)).not.toBe(before);
  });

  it('changes when a node moves to another parent, which is semantics rather than layout', () => {
    const ir = threeTier();
    const before = irDigest(ir);

    const service = ir.nodes.find((node) => node.id === 'ecs-api');
    if (!service) throw new Error('fixture lost its service');
    service.parent = 'subnet-public-a';

    expect(irDigest(ir)).not.toBe(before);
  });

  it('is unchanged by the order nodes and edges happen to be written in', () => {
    const ir = threeTier();
    const before = irDigest(ir);

    ir.nodes.reverse();
    ir.edges.reverse();

    expect(irDigest(ir)).toBe(before);
  });

  it('is a sha-256, so it can be compared as a fixed-width string', () => {
    expect(irDigest(threeTier())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('patchDigest', () => {
  it('excludes the summary from the patch digest', () => {
    const ops: IrPatch['ops'] = [
      { op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true },
    ];

    expect(patchDigest(patchOf(ops, 'Make the database Multi-AZ'))).toBe(
      patchDigest(patchOf(ops, 'Improve database availability'))
    );
  });

  it('changes when any operation changes', () => {
    const original = patchDigest(
      patchOf([{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: true }], 'x')
    );

    expect(
      patchDigest(
        patchOf([{ op: 'set_param', nodeId: 'rds-primary', param: 'multiAz', value: false }], 'x')
      )
    ).not.toBe(original);
    expect(
      patchDigest(
        patchOf([{ op: 'set_param', nodeId: 'rds-standby', param: 'multiAz', value: true }], 'x')
      )
    ).not.toBe(original);
    expect(patchDigest(patchOf([], 'x'))).not.toBe(original);
  });

  it('changes when the document the patch was computed against changes', () => {
    const ops: IrPatch['ops'] = [{ op: 'remove_edge', edgeId: 'api-to-db' }];
    const patch = patchOf(ops, 'Disconnect the database');

    expect(patchDigest({ ...patch, basedOnIrDigest: 'b'.repeat(64) })).not.toBe(patchDigest(patch));
  });
});
