import type { ArchitectureIr, IrNode, ResourceKind } from '@infracanvas/ir-schema';

import { getResourceContract } from '../../resources/registry';
import {
  DEFAULT_USAGE,
  usd,
  type CostEstimate,
  type UsageAssumptions,
} from '../../resources/contract';
import {
  USAGE_ASSUMPTION_IDS,
  defaultAssumptions,
  usageFor,
  withOverride,
  type AssumptionSet,
} from '../assumptions';
import { predicted, type Assumption, type Prediction } from '../prediction';

export interface CostLine {
  resourceId: string;
  label: string;
  unit: string;
  quantity: number;
  unitPriceUsd: number;
  monthlyUsd: number;
  /** Assumption ids this quantity moved with. Empty means a fixed rate. */
  assumptionIds: string[];
}

export interface ResourceCost {
  resourceId: string;
  kind: ResourceKind;
  monthlyUsd: number;
  lines: CostLine[];
  /** Identifies the snapshot the prices came from, so a figure can be traced to a published list. */
  priceSource: CostEstimate['priceSource'] | null;
  /** One entry per thing that could not be priced, with the reason. */
  unpriced: string[];
}

export interface ArchitectureCost {
  monthlyUsd: number;
  byResource: ResourceCost[];
  /** Resource ids and reasons, so a cheap-looking total can be checked for what is missing. */
  unpriced: string[];
}

export interface CostContext {
  region: string;
  assumptions: AssumptionSet;
}

export function costContext(region = DEFAULT_USAGE.region): CostContext {
  return { region, assumptions: defaultAssumptions() };
}

/**
 * A perturbation large enough to move a line out of floating-point noise and
 * small enough not to cross a pricing tier boundary, which would report a
 * dependency that exists only at that tier.
 */
const PROBE_FACTOR = 1.000_001;

/**
 * Which assumptions a cost line depends on is measured rather than declared.
 *
 * The alternative is for each contract to list the assumption ids its
 * components read, which is a second statement of what the arithmetic already
 * says and drifts the first time a formula changes without its list. Probing
 * instead re-runs the model with one assumption nudged and records the
 * components that moved, so the dependency is a fact about the code rather than
 * a comment on it. Contracts are pure arithmetic over a handful of numbers, so
 * eight extra evaluations per resource is cheaper than the bookkeeping.
 *
 * A line that does not move is reported as depending on nothing, which is
 * correct: a fixed monthly charge is not made arguable by attaching a traffic
 * figure to it.
 */
function dependenciesOf(
  node: IrNode,
  ctx: CostContext,
  baseline: CostEstimate
): Map<number, string[]> {
  const byComponent = new Map<number, string[]>();
  for (let index = 0; index < baseline.components.length; index += 1) byComponent.set(index, []);

  for (const id of USAGE_ASSUMPTION_IDS) {
    const assumption = ctx.assumptions.get(id);
    if (assumption === undefined) continue;
    const probeValue = assumption.value === 0 ? 1 : assumption.value * PROBE_FACTOR;
    const probed = priceWith(node, {
      ...ctx,
      assumptions: withOverride(ctx.assumptions, id, probeValue, 'user'),
    });
    if (probed === null) continue;

    for (let index = 0; index < baseline.components.length; index += 1) {
      const before = baseline.components[index];
      const after = probed.components[index];
      if (after === undefined || before === undefined) continue;
      if (after.quantity !== before.quantity || after.monthlyUsd !== before.monthlyUsd) {
        byComponent.get(index)?.push(id);
      }
    }
  }
  return byComponent;
}

function priceWith(node: IrNode, ctx: CostContext): CostEstimate | null {
  const contract = getResourceContract(node.kind);
  if (contract === undefined) return null;
  const usage: UsageAssumptions = usageFor(node.kind, ctx.assumptions, ctx.region);
  // The registry is heterogeneous by construction; the lookup by `node.kind`
  // is what pairs the params with the contract that types them.
  return contract.cost(node.params as never, usage);
}

/**
 * A resource with no contract is reported, never charged zero. Silently
 * contributing nothing makes a missing model look like a cheap architecture,
 * which is the single most misleading thing this feature could do.
 */
export function costModel(node: IrNode, ctx: CostContext): Prediction<ResourceCost> {
  const estimate = priceWith(node, ctx);
  if (estimate === null) {
    const unpriced = [`${node.id}: no cost model for ${node.kind}`];
    return predicted<ResourceCost>(
      {
        resourceId: node.id,
        kind: node.kind,
        monthlyUsd: 0,
        lines: [],
        priceSource: null,
        unpriced,
      },
      [],
      gapsFor(unpriced)
    );
  }

  const dependencies = dependenciesOf(node, ctx, estimate);
  const lines: CostLine[] = estimate.components.map((component, index) => ({
    resourceId: node.id,
    label: component.label,
    unit: component.unit,
    quantity: component.quantity,
    unitPriceUsd: component.unitPriceUsd,
    monthlyUsd: component.monthlyUsd,
    assumptionIds: dependencies.get(index) ?? [],
  }));

  const used = new Set(lines.flatMap((line) => line.assumptionIds));
  const assumptions = [...used]
    .map((id) => ctx.assumptions.get(id))
    .filter((assumption): assumption is Assumption => assumption !== undefined);

  const unpriced = estimate.unpriced.map((reason) => `${node.id}: ${reason}`);
  return predicted<ResourceCost>(
    {
      resourceId: node.id,
      kind: node.kind,
      monthlyUsd: estimate.monthlyUsd,
      lines,
      priceSource: estimate.priceSource,
      unpriced,
    },
    assumptions,
    gapsFor(unpriced)
  );
}

/** One phrasing for both a fresh price and a carried-over one, so a revision compares equal to a full recomputation. */
function gapsFor(unpriced: string[]): string[] {
  return unpriced.map((entry) => `Not included in the total, ${entry}`);
}

export function rollUpCost(costs: Prediction<ResourceCost>[]): Prediction<ArchitectureCost> {
  const byResource = costs.map((cost) => cost.value);
  return predicted<ArchitectureCost>(
    {
      // Summed in cents so a forty-line architecture does not drift by a
      // fraction of a penny and disagree with its own breakdown.
      monthlyUsd: usd(
        byResource.reduce((total, resource) => total + Math.round(resource.monthlyUsd * 100), 0) /
          100
      ),
      byResource,
      unpriced: byResource.flatMap((resource) => resource.unpriced),
    },
    costs.flatMap((cost) => cost.assumptions),
    costs.flatMap((cost) => cost.gaps)
  );
}

/** Prices every node in a document. Nodes the canvas draws but AWS does not bill for are skipped. */
export function costArchitecture(
  document: ArchitectureIr,
  ctx: CostContext = costContext()
): Prediction<ArchitectureCost> {
  return rollUpCost(document.nodes.map((node) => costModel(node, ctx)));
}

/**
 * Recomputes only the resources with a line that moved with the changed
 * assumption; the rest are carried over by reference rather than re-priced.
 *
 * The epic requires that editing an assumption does not re-run the analysis.
 * At this size a full recomputation would also be fast, but an index used only
 * as an optimisation is an index nothing checks, and this one is asserted
 * against a full recomputation on every change.
 */
export function reviseAssumption(
  document: ArchitectureIr,
  estimate: Prediction<ArchitectureCost>,
  id: string,
  value: number,
  ctx: CostContext
): Revision {
  const assumptions = withOverride(ctx.assumptions, id, value);
  const next: CostContext = { ...ctx, assumptions };
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const recomputed: string[] = [];

  const costs = estimate.value.byResource.map((resource) => {
    const node = nodes.get(resource.resourceId);
    const affected = resource.lines.some((line) => line.assumptionIds.includes(id));
    if (node === undefined || !affected) {
      return carriedOver(resource, assumptions);
    }
    recomputed.push(resource.resourceId);
    return costModel(node, next);
  });

  return { estimate: rollUpCost(costs), context: next, recomputed };
}

export interface Revision {
  estimate: Prediction<ArchitectureCost>;
  /** The context to pass to the next revision, carrying the override. */
  context: CostContext;
  /** Resource ids that were re-priced, so a test can assert the rest were not. */
  recomputed: string[];
}

/**
 * An unaffected resource keeps its lines by reference and only refreshes the
 * assumption records it reports, so an override the user made elsewhere still
 * shows as theirs on a figure that did not move.
 */
function carriedOver(resource: ResourceCost, assumptions: AssumptionSet): Prediction<ResourceCost> {
  const used = resource.lines
    .flatMap((line) => line.assumptionIds)
    .map((usedId) => assumptions.get(usedId))
    .filter((assumption): assumption is Assumption => assumption !== undefined);
  return predicted<ResourceCost>(resource, used, gapsFor(resource.unpriced));
}
