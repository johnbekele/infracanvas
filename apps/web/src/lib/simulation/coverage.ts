import {
  getServiceById,
  kindToServiceId,
  listResourceContracts,
  serviceCategories,
  type ArchitectureFindings,
  type Pillar,
  type ResourceKind,
  type ServiceCategory,
} from '@infracanvas/core';

/**
 * What was actually checked, and what a silence means.
 *
 * A findings panel that shows six green pillars because no rule reported
 * anything is the most expensive lie a review tool can tell: the reader
 * concludes the architecture passed a review that never ran. Today the registry
 * carries rules for one resource kind across three pillars, so the page has to
 * distinguish "checked and clean" from "nothing looked".
 */

export const PILLARS: readonly Pillar[] = [
  'operational-excellence',
  'security',
  'reliability',
  'performance-efficiency',
  'cost-optimisation',
  'sustainability',
];

export const PILLAR_NAMES: Record<Pillar, string> = {
  'operational-excellence': 'Operational excellence',
  security: 'Security',
  reliability: 'Reliability',
  'performance-efficiency': 'Performance efficiency',
  'cost-optimisation': 'Cost optimisation',
  sustainability: 'Sustainability',
};

export interface PillarCoverage {
  pillar: Pillar;
  name: string;
  /** How many rules across the whole registry could speak to this pillar. */
  rulesAvailable: number;
  findings: number;
  highSeverity: number;
  /** False when no rule exists for this pillar, so silence proves nothing. */
  checked: boolean;
}

export function pillarCoverage(findings: ArchitectureFindings): PillarCoverage[] {
  const available = new Map<Pillar, number>();
  for (const contract of listResourceContracts()) {
    for (const rule of contract.rules) {
      available.set(rule.pillar, (available.get(rule.pillar) ?? 0) + 1);
    }
  }

  return PILLARS.map((pillar) => {
    const raised = findings.byPillar[pillar] ?? [];
    const rulesAvailable = available.get(pillar) ?? 0;
    return {
      pillar,
      name: PILLAR_NAMES[pillar],
      rulesAvailable,
      findings: raised.length,
      highSeverity: raised.filter((finding) => finding.severity === 'high').length,
      checked: rulesAvailable > 0,
    };
  });
}

const CATEGORY_COLOURS = new Map<string, string>(
  serviceCategories.map((entry) => [entry.id, entry.color])
);

export interface KindCategory {
  category: ServiceCategory | 'unmapped';
  name: string;
  colour: string;
}

const UNMAPPED: KindCategory = { category: 'unmapped', name: 'Uncategorised', colour: '#9ca3af' };

/**
 * A resource kind's place in the catalogue, which is how cost is grouped.
 *
 * Grouping goes through the same `kind` to service mapping the canvas uses, so
 * a total on this page and a shape on the canvas cannot disagree about what a
 * resource is.
 */
export function categoryOfKind(kind: ResourceKind): KindCategory {
  const serviceId = kindToServiceId(kind);
  if (serviceId === undefined) return UNMAPPED;

  const service = getServiceById(serviceId);
  if (service === undefined) return UNMAPPED;

  const entry = serviceCategories.find((candidate) => candidate.id === service.category);
  return {
    category: service.category,
    name: entry?.name ?? service.category,
    colour: CATEGORY_COLOURS.get(service.category) ?? UNMAPPED.colour,
  };
}

/** The catalogue's display name for a kind, falling back to the kind itself. */
export function serviceNameOfKind(kind: ResourceKind): string {
  const serviceId = kindToServiceId(kind);
  const service = serviceId === undefined ? undefined : getServiceById(serviceId);
  return service?.name ?? kind.replace(/_/g, ' ');
}
