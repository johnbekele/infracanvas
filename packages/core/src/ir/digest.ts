import type { ArchitectureIr } from '@infracanvas/ir-schema';

import { normaliseIr } from './normalise';
import { sha256Hex } from './sha256';
import type { IrPatch } from './patch';

/**
 * A JSON encoding two processes can agree on: object keys in code-unit order,
 * no whitespace, and undefined dropped rather than serialised. `JSON.stringify`
 * alone is not enough, because it preserves insertion order, so two documents
 * that differ only in the order their keys were written would digest
 * differently and every open proposal against one of them would look stale.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

  return `{${entries.join(',')}}`;
}

/**
 * The semantic encoding of a document: normalised, then stripped of every
 * `layout` object and of `presentation`.
 *
 * Where a node sits on the canvas is not part of what the architecture is, and
 * including it would mean that dragging a box invalidates every open proposal.
 * Reading a suggestion while rearranging the canvas is ordinary behaviour, not
 * a conflict.
 */
export function semanticEncoding(ir: ArchitectureIr): string {
  const normalised = normaliseIr(ir);
  return canonicalJson({
    irVersion: normalised.irVersion,
    name: normalised.name,
    provider: normalised.provider,
    region: normalised.region,
    nodes: normalised.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      parent: node.parent ?? null,
      params: node.params,
    })),
    edges: normalised.edges,
  });
}

export function irDigest(ir: ArchitectureIr): string {
  return sha256Hex(semanticEncoding(ir));
}

/**
 * The bytes a proposal is identified by. `summary` is excluded because it is
 * prose for a diff card: rewording it must not turn one proposal into two, and
 * two proposals that differ only in their wording are the same edit.
 */
export function patchDigest(patch: IrPatch): string {
  return sha256Hex(
    canonicalJson({
      patchVersion: patch.patchVersion,
      basedOnIrDigest: patch.basedOnIrDigest,
      ops: patch.ops,
    })
  );
}
