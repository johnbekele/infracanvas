import { describe, expect, it } from 'vitest';

import type { IrNode } from '../nodes.js';
import { pendingContractKinds, resourceKinds, typedContractKinds } from '../validate.js';
import type { ResourceKind, SubnetNode, VpcNode } from './types.js';

/**
 * These assertions are the point of generating types at all, and most of them
 * are compile-time: the file failing to type-check is the failure. The runtime
 * bodies exist so the cases appear in the test report rather than silently
 * passing because nobody imported this file.
 */

describe('the generated node union', () => {
  it('discriminates params by kind', () => {
    function paramsOf(node: IrNode): string {
      switch (node.kind) {
        case 'vpc':
          // Narrowed to VpcParams; `cidrBlock` is not on the other branches.
          return node.params.cidrBlock;
        case 'subnet':
          return node.params.availabilityZone;
        case 'rds_instance':
          return node.params.instanceClass;
        default:
          // Everything left is a pending kind, whose parameters are still a bag.
          return String(node.params.anything ?? '');
      }
    }

    const vpc: VpcNode = {
      id: 'vpc-main',
      kind: 'vpc',
      name: 'Main',
      params: { cidrBlock: '10.0.0.0/16' },
    };
    expect(paramsOf(vpc)).toBe('10.0.0.0/16');
  });

  it('rejects a params object belonging to another kind', () => {
    const subnet: SubnetNode = {
      id: 'subnet-a',
      kind: 'subnet',
      name: 'A',
      params: { tier: 'public', cidrBlock: '10.0.1.0/24', availabilityZone: 'eu-west-1a' },
    };

    // @ts-expect-error a subnet cannot carry a VPC's parameters
    const wrong: SubnetNode = { ...subnet, params: { cidrBlock: '10.0.0.0/16' } };
    expect(wrong.kind).toBe('subnet');
  });

  it('covers every resource kind the schema declares', () => {
    // Compile-time: the two spellings of the kind set have to agree, so a kind
    // added to the schema without a branch is a type error rather than a
    // resource nothing can represent.
    type FromUnion = IrNode['kind'];
    const bothWays: [
      FromUnion extends ResourceKind ? true : false,
      ResourceKind extends FromUnion ? true : false,
    ] = [true, true];
    expect(bothWays).toEqual([true, true]);

    // Runtime, over the same schema the types came from.
    const pending = new Set<string>(pendingContractKinds());
    const typed = resourceKinds().filter((kind) => !pending.has(kind));
    expect(typed).toEqual(typedContractKinds());
  });
});
