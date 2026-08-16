import type { ArchitectureIr, IrNode, ResourceKind } from '@infracanvas/ir-schema';

import type { Pillar, RuleFinding, Severity } from './contract';
import { getResourceContract } from './registry';

/**
 * Runs every registered rule over a document. Rules are written per resource
 * and need their node's ancestors to answer questions like which subnet tier a
 * database sits in, so the walk happens here rather than in each rule.
 */

export interface ArchitectureFindings {
  findings: RuleFinding[];
  /** Findings per pillar, so a panel can show where an architecture is weakest. */
  byPillar: Record<Pillar, RuleFinding[]>;
  /** Kinds present in the document that no rule could evaluate, so silence is not read as a pass. */
  unchecked: ResourceKind[];
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function ancestorsOf(node: IrNode, byId: ReadonlyMap<string, IrNode>): IrNode[] {
  const ancestors: IrNode[] = [];
  const seen = new Set<string>([node.id]);
  let parent = node.parent;
  while (parent !== undefined && parent !== null && !seen.has(parent)) {
    const found = byId.get(parent);
    if (found === undefined) break;
    ancestors.push(found);
    seen.add(found.id);
    parent = found.parent;
  }
  return ancestors;
}

export function evaluateArchitecture(document: ArchitectureIr): ArchitectureFindings {
  const nodes = document.nodes as IrNode[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const findings: RuleFinding[] = [];
  const unchecked = new Set<ResourceKind>();

  for (const node of nodes) {
    const contract = getResourceContract(node.kind);
    if (contract === undefined) {
      unchecked.add(node.kind);
      continue;
    }
    const context = { ancestors: ancestorsOf(node, byId), region: document.region };
    for (const rule of contract.rules) {
      // A rule returns null when it passes and never throws, so one resource
      // with an absent parameter cannot silence the rest of the architecture.
      const finding = rule.evaluate(node.params as never, context);
      if (finding !== null) findings.push({ ...finding, pointer: `${node.id}${finding.pointer}` });
    }
  }

  // Highest severity first, then by resource, so the list reads as a worklist
  // rather than in whatever order the document happened to be written in.
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0)
  );

  const byPillar = {
    'operational-excellence': [],
    security: [],
    reliability: [],
    'performance-efficiency': [],
    'cost-optimisation': [],
    sustainability: [],
  } as Record<Pillar, RuleFinding[]>;
  for (const finding of findings) byPillar[finding.pillar].push(finding);

  return { findings, byPillar, unchecked: [...unchecked].sort() };
}
