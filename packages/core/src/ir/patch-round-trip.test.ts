import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { IR_VERSION, type ArchitectureIr, type IrNode } from '@infracanvas/ir-schema';

import { irDigest } from './digest';
import { normaliseIr } from './normalise';
import { applyPatch, invertPatch, IR_PATCH_VERSION, type IrPatchOp } from './patch';

/**
 * The interesting failures in this protocol are in operation sequences nobody
 * thought to write down: a `move_node` followed by a `remove_node` of the old
 * parent, a `set_param` on a parameter a later `replace_kind` deletes. Generated
 * cases find those; a handful of fixtures does not.
 *
 * A hand-rolled generator was considered and rejected. Shrinking a failing
 * twelve-operation sequence down to its minimal case is the entire value of the
 * exercise, and shrinking is the part nobody writes by hand.
 */

/** Kinds whose parameters are an untyped bag, so a generated value cannot fail the schema. */
const KINDS = ['s3_bucket', 'sqs_queue', 'sns_topic', 'dynamodb_table'] as const;

const REGION = 'eu-west-1';

interface Shape {
  services: number;
  subnets: number;
  placements: number[];
  kinds: (typeof KINDS)[number][];
  links: [number, number][];
}

function build(shape: Shape): ArchitectureIr {
  const nodes: IrNode[] = [
    {
      id: 'vpc-0',
      kind: 'vpc',
      name: 'VPC',
      layout: { x: 0, y: 0 },
      params: { cidrBlock: '10.0.0.0/16' },
    },
  ];

  for (let index = 0; index < shape.subnets; index += 1) {
    nodes.push({
      id: `subnet-${index}`,
      kind: 'subnet',
      name: `Subnet ${index}`,
      parent: 'vpc-0',
      layout: { x: index * 100, y: 100 },
      params: {
        tier: index % 2 === 0 ? 'public' : 'private',
        cidrBlock: `10.0.${index + 1}.0/24`,
        availabilityZone: `${REGION}a`,
      },
    });
  }

  const placements = ['vpc-0', 'subnet-0', null];
  for (let index = 0; index < shape.services; index += 1) {
    const parent = placements[shape.placements[index] % placements.length];
    nodes.push({
      id: `svc-${index}`,
      kind: shape.kinds[index],
      name: `Service ${index}`,
      parent: parent === 'subnet-0' && shape.subnets === 0 ? 'vpc-0' : parent,
      layout: { x: index * 60, y: 300 },
      params: { size: index + 1 },
    });
  }

  const seen = new Set<string>();
  const edges = shape.links
    .filter(([from, to]) => from < shape.services && to < shape.services && from !== to)
    .map(([from, to]) => ({
      id: `edge-${from}-${to}`,
      kind: 'connects' as const,
      source: `svc-${from}`,
      target: `svc-${to}`,
    }))
    .filter((edge) => (seen.has(edge.id) ? false : seen.add(edge.id) !== undefined));

  return {
    irVersion: IR_VERSION,
    name: 'Generated architecture',
    provider: 'aws',
    region: REGION,
    nodes,
    edges,
    presentation: { viewport: { x: 0, y: 0, zoom: 1 } },
  };
}

function arbitraryIr(): fc.Arbitrary<ArchitectureIr> {
  return fc
    .record({
      services: fc.integer({ min: 1, max: 5 }),
      subnets: fc.integer({ min: 1, max: 2 }),
      placements: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 5, maxLength: 5 }),
      kinds: fc.array(fc.constantFrom(...KINDS), { minLength: 5, maxLength: 5 }),
      links: fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 })), {
        maxLength: 4,
      }),
    })
    .map(build);
}

function arbitraryOps(ir: ArchitectureIr): fc.Arbitrary<IrPatchOp[]> {
  const nodeIds = ir.nodes.map((node) => node.id);
  const serviceIds = nodeIds.filter((id) => id.startsWith('svc-'));
  const edgeIds = ir.edges.map((edge) => edge.id);

  const choices: fc.Arbitrary<IrPatchOp>[] = [
    fc
      .tuple(
        fc.constantFrom(...serviceIds),
        fc.constantFrom('size', 'retentionDays', 'encrypted'),
        fc.oneof(
          fc.integer({ min: 0, max: 90 }),
          fc.boolean(),
          fc.constantFrom('gp2', 'gp3'),
          fc.constant(null)
        )
      )
      .map(([nodeId, param, value]) => ({ op: 'set_param', nodeId, param, value })),
    fc
      .tuple(fc.integer({ min: 0, max: 3 }), fc.constantFrom(...KINDS), fc.constantFrom(...nodeIds))
      .map(([index, kind, parent]) => ({
        op: 'add_node',
        node: {
          id: `added-${index}`,
          kind,
          name: `Added ${index}`,
          parent,
          layout: { x: 0, y: 0 },
          params: { size: index },
        } as IrNode,
      })),
    fc.constantFrom(...nodeIds).map((nodeId) => ({ op: 'remove_node', nodeId })),
    fc
      .tuple(
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom(...nodeIds),
        fc.constantFrom(...nodeIds)
      )
      .map(([index, source, target]) => ({
        op: 'add_edge',
        edge: { id: `added-edge-${index}`, kind: 'connects', source, target },
      })),
    fc
      .tuple(fc.constantFrom(...nodeIds), fc.oneof(fc.constantFrom(...nodeIds), fc.constant(null)))
      .map(([nodeId, parent]) => ({ op: 'move_node', nodeId, parent })),
    fc
      .tuple(fc.constantFrom(...serviceIds), fc.constantFrom(...KINDS))
      .map(([nodeId, kind]) => ({ op: 'replace_kind', nodeId, kind, params: { size: 1 } })),
  ];

  if (edgeIds.length > 0) {
    choices.push(fc.constantFrom(...edgeIds).map((edgeId) => ({ op: 'remove_edge', edgeId })));
  }

  return fc.array(fc.oneof(...choices), { minLength: 1, maxLength: 6 });
}

describe('patch round trip', () => {
  it('round trips every generated operation sequence', () => {
    let applied = 0;

    fc.assert(
      fc.property(
        arbitraryIr().chain((ir) => fc.tuple(fc.constant(ir), arbitraryOps(ir))),
        ([ir, ops]) => {
          const patch = {
            patchVersion: IR_PATCH_VERSION,
            basedOnIrDigest: irDigest(ir),
            summary: '',
            ops,
          } as const;

          const forward = applyPatch(ir, patch);
          // A sequence the document refuses is not a counterexample: this
          // property is about patches that apply, and the refusals have their
          // own tests.
          fc.pre(forward.ok);
          if (!forward.ok) return;
          applied += 1;

          const back = applyPatch(forward.ir, invertPatch(ir, patch));
          expect(back.ok).toBe(true);
          if (!back.ok) return;
          expect(irDigest(back.ir)).toBe(irDigest(ir));
          expect(normaliseIr(back.ir)).toEqual(normaliseIr(ir));
        }
      ),
      { numRuns: 500 }
    );

    // A property that silently skipped every case would pass while proving
    // nothing, so the yield is asserted rather than assumed.
    expect(applied).toBeGreaterThan(100);
  });
});
