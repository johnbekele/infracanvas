// Revision 1 of an experiment, built from what the analysis found.
//
// An experiment created against a repository starts from the architecture the
// deterministic proposer derives from its newest succeeded analysis, rather than
// from an empty canvas. Seeding from a failed or absent profile would produce an
// empty architecture that looks like a product bug, so the absence of an analysis
// is reported to the caller instead.
import {
  IR_VERSION,
  proposeArchitecture,
  serviceIdToKind,
  type ArchitectureIr,
  type ArchitectureProposal,
  type IrEdge,
  type IrNode,
  type ProposedNode,
} from '@infracanvas/core';
import { validateIr, type IrProblem } from '@infracanvas/ir-schema';
import { latestSucceededAnalysis } from '../db/analyses.js';
import type { Repository } from '../db/repositories.js';

/** Raised when the repository has nothing to seed from. The route answers 409. */
export class NoAnalysisError extends Error {
  constructor() {
    super('This repository has no succeeded analysis to seed an architecture from');
    this.name = 'NoAnalysisError';
  }
}

/**
 * Raised when the proposal cannot be expressed as a valid IR document.
 *
 * This is a fault on our side rather than the caller's, and it is raised instead
 * of storing the document anyway: a revision holding an architecture the
 * validator rejects is a revision nothing downstream can price.
 */
export class SeedConversionError extends Error {
  readonly problems: IrProblem[];

  constructor(message: string, problems: IrProblem[]) {
    super(message);
    this.name = 'SeedConversionError';
    this.problems = problems;
  }
}

export interface SeededArchitecture {
  ir: ArchitectureIr;
  analysisId: string;
  /** Capabilities the proposer found that the catalogue cannot draw. */
  gaps: string[];
}

/** A proposed node's properties, which the IR carries as a parameter bag. */
function bag(node: ProposedNode): Record<string, string | number | boolean> {
  return { ...node.properties };
}

function stringParam(node: ProposedNode, key: string, fallback: string): string {
  const value = node.properties[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberParam(node: ProposedNode, key: string, fallback: number): number {
  const value = node.properties[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * The typed kinds need their parameters shaped rather than copied, because the
 * proposer speaks in catalogue properties and the schema speaks in resource
 * contracts. Everything else is a pending contract, whose parameters are an open
 * bag until #78 gives it one.
 */
function nodeFor(proposed: ProposedNode, region: string): IrNode | null {
  const kind = serviceIdToKind(proposed.serviceId);
  if (!kind) return null;

  const base = {
    id: proposed.id,
    name: stringParam(proposed, 'name', proposed.id),
    ...(proposed.parentId ? { parent: proposed.parentId } : {}),
    layout: {
      x: proposed.position.x,
      y: proposed.position.y,
      ...(proposed.size ? { width: proposed.size.width, height: proposed.size.height } : {}),
    },
  };

  switch (kind) {
    case 'vpc':
      return {
        ...base,
        kind,
        params: { cidrBlock: stringParam(proposed, 'cidrBlock', '10.0.0.0/16') },
      };

    case 'subnet':
      return {
        ...base,
        kind,
        params: {
          // The catalogue distinguishes the two tiers by entry rather than by a
          // property, which is where the tier has to come from.
          tier: proposed.serviceId === 'public-subnet' ? 'public' : 'private',
          cidrBlock: stringParam(proposed, 'cidrBlock', '10.0.1.0/24'),
          availabilityZone: stringParam(proposed, 'availabilityZone', `${region}a`),
        },
      };

    case 'rds_instance': {
      const engine = stringParam(proposed, 'engine', 'postgres');
      return {
        ...base,
        kind,
        params: {
          engine: engine === 'mysql' || engine === 'mariadb' ? engine : 'postgres',
          instanceClass: stringParam(proposed, 'instanceClass', 'db.t4g.micro'),
          allocatedStorageGb: numberParam(proposed, 'allocatedStorageGb', 20),
        },
      };
    }

    default:
      return { ...base, kind, params: bag(proposed) };
  }
}

/** Every proposed edge is a connection until the proposer says otherwise. */
function edgesFor(proposal: ArchitectureProposal, placed: Set<string>): IrEdge[] {
  return proposal.edges
    .filter((edge) => placed.has(edge.source) && placed.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      kind: 'connects' as const,
      source: edge.source,
      target: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
    }));
}

/**
 * Convert a proposal into an IR document.
 *
 * A node the catalogue has no IR kind for fails the conversion rather than being
 * dropped, because an architecture missing a resource prices differently from the
 * one the analysis actually described.
 */
export function proposalToIr(proposal: ArchitectureProposal, region: string): ArchitectureIr {
  const nodes: IrNode[] = [];
  const unmapped: IrProblem[] = [];

  for (const proposed of proposal.nodes) {
    const node = nodeFor(proposed, region);
    if (!node) {
      unmapped.push({
        pointer: `/nodes/${proposed.id}/kind`,
        message: `${proposed.serviceId} has no IR resource kind, so it cannot be stored`,
        source: 'reference',
      });
      continue;
    }
    nodes.push(node);
  }

  if (unmapped.length > 0) {
    throw new SeedConversionError(
      'The proposed architecture contains resources the IR cannot express yet.',
      unmapped
    );
  }

  const placed = new Set(nodes.map((node) => node.id));
  const ir: ArchitectureIr = {
    irVersion: IR_VERSION,
    name: proposal.name,
    provider: 'aws',
    region,
    nodes,
    edges: edgesFor(proposal, placed),
  };

  const result = validateIr(ir);
  if (!result.valid) {
    throw new SeedConversionError(
      'The proposed architecture does not validate against the IR schema.',
      result.problems
    );
  }
  return result.document;
}

/**
 * The architecture to start an experiment on this repository from.
 *
 * Reads the newest succeeded analysis rather than starting one: analysis is a
 * separate operation the caller can already trigger, and a create request that
 * silently ran one would take seconds and hide a failure inside a 201.
 */
export async function seedFromLatestAnalysis(
  repository: Repository,
  region: string
): Promise<SeededArchitecture> {
  const analysis = await latestSucceededAnalysis(repository.id);
  if (!analysis?.profile) throw new NoAnalysisError();

  const proposal = proposeArchitecture(analysis.profile, repository.githubName);

  return {
    ir: proposalToIr(proposal, region),
    analysisId: analysis.id,
    gaps: proposal.gaps,
  };
}
