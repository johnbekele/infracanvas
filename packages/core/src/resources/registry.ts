import { resourceKinds, type ResourceKind } from '@infracanvas/ir-schema';

import type { ResourceContract } from './contract';

/**
 * Module-level state is deliberate: a contract is a property of the resource
 * kind, not of a request, and threading a registry instance through every cost
 * call would be ceremony around a table that is the same in every process.
 *
 * The map is heterogeneous - each key holds the contract for exactly that kind
 * - which TypeScript cannot express about a `Map`. The two casts below are
 * where that guarantee lives, and `registerResource` keying by `contract.kind`
 * is what upholds it.
 */
const contracts = new Map<ResourceKind, ResourceContract<ResourceKind>>();

/**
 * Throws on a conflict rather than replacing. Two *different* contracts for one
 * kind means whichever module imported last decides what a database costs, and
 * that is a bug worth failing at startup for rather than discovering in a price.
 *
 * Registering the same contract again is not that bug, and is a no-op. Several
 * independent entry points populate the registry before use - the preview
 * plane, the internal preview route, the browser's estimate - and each has to
 * assume it might be first. Making the second call fatal would mean the process
 * survived or died on which of them was imported, which is exactly the kind of
 * order dependence this module exists to avoid.
 */
export function registerResource<K extends ResourceKind>(contract: ResourceContract<K>): void {
  const existing = contracts.get(contract.kind);
  if (existing === (contract as unknown as ResourceContract<ResourceKind>)) return;
  if (existing !== undefined) {
    throw new Error(`A different resource contract for ${contract.kind} is already registered.`);
  }
  contracts.set(contract.kind, contract as unknown as ResourceContract<ResourceKind>);
}

export function getResourceContract<K extends ResourceKind>(
  kind: K
): ResourceContract<K> | undefined {
  return contracts.get(kind) as unknown as ResourceContract<K> | undefined;
}

/** Registration order is not meaningful, so the list is sorted by kind. */
export function listResourceContracts(): ResourceContract<ResourceKind>[] {
  return [...contracts.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** Kinds the schema knows that nothing can price, model or emit yet. */
export function kindsWithoutContract(): ResourceKind[] {
  return resourceKinds().filter((kind) => !contracts.has(kind));
}

/** Test-only. Restores an empty registry so one test's registration cannot leak into another. */
export function resetResourceRegistry(): void {
  contracts.clear();
}
