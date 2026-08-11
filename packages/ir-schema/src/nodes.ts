import type { PendingContractNode, SubnetNode, VpcNode } from './generated/types.js';

/**
 * The node union, discriminated by `kind`.
 *
 * It is written here rather than generated because `json-schema-to-typescript`
 * emits the three branches and the array that holds them, but no name for the
 * union itself. Everything about it that could drift from the schema - the
 * members, their parameters - is generated; this line only gives the sum a
 * name, and `src/generated/types.test.ts` asserts it covers every kind.
 */
export type IrNode = VpcNode | SubnetNode | PendingContractNode;
