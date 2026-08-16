import type { ArchitectureIr, IrNode, ResourceKind } from '@infracanvas/ir-schema';

import { getResourceContract } from '../resources/registry';
import type { RuleFinding } from '../resources/contract';

/**
 * Nothing aggregates Well-Architected rules today: they live per resource on
 * `ResourceContract.rules` and are evaluated one node at a time with a context
 * carrying that node's ancestors. A preview has to compare every finding in one
 * document with every finding in another, so the walk belongs here rather than
 * being written twice.
 */

/** A finding together with the resource it was raised against, which a diff needs and `RuleFinding` does not carry. */
export interface NodeFinding {
  resourceId: string;
  kind: ResourceKind;
  finding: RuleFinding;
}

/** A node whose kind has no contract, so no rule could have fired for it. */
export interface UnruledNode {
  resourceId: string;
  kind: ResourceKind;
}

export interface RuleCoverage {
  findings: NodeFinding[];
  /**
   * Kinds with no contract. Reported rather than omitted, because "no rules
   * fired" and "no rules exist" look identical on a diff card otherwise.
   */
  unruled: UnruledNode[];
}

/** Ancestors nearest first, walked rather than recursed so a cycle cannot exhaust the stack. */
function ancestorsOf(node: IrNode, byId: ReadonlyMap<string, IrNode>): IrNode[] {
  const chain: IrNode[] = [];
  const seen = new Set<string>([node.id]);
  let parentId = node.parent ?? null;

  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    chain.push(parent);
    seen.add(parent.id);
    parentId = parent.parent ?? null;
  }
  return chain;
}

export function ruleCoverage(ir: ArchitectureIr): RuleCoverage {
  const byId = new Map(ir.nodes.map((node) => [node.id, node]));
  const findings: NodeFinding[] = [];
  const unruled: UnruledNode[] = [];

  ir.nodes.forEach((node, index) => {
    const contract = getResourceContract(node.kind);
    if (contract === undefined) {
      unruled.push({ resourceId: node.id, kind: node.kind });
      return;
    }

    const context = { ancestors: ancestorsOf(node, byId), region: ir.region };
    for (const rule of contract.rules) {
      // The registry is heterogeneous by construction; the lookup by
      // `node.kind` is what pairs the params with the rule that types them.
      const finding = rule.evaluate(node.params as never, context);
      if (finding === null) continue;

      findings.push({
        resourceId: node.id,
        kind: node.kind,
        finding: {
          ...finding,
          // A rule points at a field of its own node. Prefixing the node's
          // position makes it a pointer into the document, which is what a
          // canvas highlighting the offending field actually needs.
          pointer: `/nodes/${index}${finding.pointer}`,
        },
      });
    }
  });

  return { findings, unruled };
}

/** Every Well-Architected finding in a document, by walking the contract registry. */
export function collectFindings(ir: ArchitectureIr): RuleFinding[] {
  return ruleCoverage(ir).findings.map((entry) => entry.finding);
}

/** Identity of a finding across two documents: the rule and the resource, never the pointer, which moves when a node is added. */
export function findingKey(entry: NodeFinding): string {
  return `${entry.finding.ruleId}\u0000${entry.resourceId}`;
}
