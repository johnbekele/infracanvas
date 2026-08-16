import type { ArchitectureIr, IrNode, ResourceKind } from '@infracanvas/ir-schema';

import { availability, type AvailabilityReport } from '../prediction/availability';
import { costArchitecture, type ArchitectureCost, type CostLine } from '../prediction/cost';
import { defaultAssumptions, type AssumptionSet } from '../prediction/assumptions';
import type { Assumption, Prediction } from '../prediction/prediction';
import type { RuleFinding } from '../resources/contract';
import { irDigest, patchDigest } from './digest';
import { findingKey, ruleCoverage, type NodeFinding } from './findings';
import { applyPatch, invertPatch, type IrPatch, type PatchProblem } from './patch';
import {
  baselineKey,
  createBaselineCache,
  createPreviewCache,
  previewKey,
  type BaselineCache,
  type PreviewCache,
} from './preview-cache';
import { PATCH_PREVIEW_VERSION } from './preview-version';

/**
 * What a proposal does to the architecture, in the terms a user decides with:
 * what it costs, what it does to availability, and which Well-Architected
 * findings it raises or resolves.
 *
 * The numbers come from the deterministic prediction plane, never from a model.
 * Asking a model to estimate the delta is nearly free and produces a plausible
 * figure nobody can check, which is worse than no figure: a cost line here
 * carries the assumptions its quantity came from, and an availability figure
 * says whether it is a published AWS commitment or a modelled one.
 *
 * An unpriced or unmodelled resource is reported, never counted as zero. Adding
 * something unpriced would otherwise look free, which is the single most
 * misleading thing a preview could say, so each dimension carries a
 * `completeness` and every unknown carries a reason and a side.
 */

export { PATCH_PREVIEW_VERSION };

/** `partial` means at least one resource could not be priced or modelled. */
export type Completeness = 'complete' | 'partial';

export interface PreviewUnknown {
  resourceId: string;
  kind: ResourceKind;
  dimension: 'cost' | 'availability' | 'rules';
  /** Plain language, shown to the user: "no cost model for elasticache_cluster". */
  reason: string;
  /** A resource unknown only after the patch makes the delta a bound rather than a figure. */
  side: 'before' | 'after' | 'both';
}

export interface ResourceCostDelta {
  resourceId: string;
  change: 'added' | 'removed' | 'changed';
  monthlyUsdBefore: number;
  monthlyUsdAfter: number;
  monthlyUsdDelta: number;
  /** Only the lines that moved. An unchanged line is noise on a diff card. */
  lines: CostLine[];
}

export interface CostDelta {
  monthlyUsdBefore: number;
  monthlyUsdAfter: number;
  monthlyUsdDelta: number;
  completeness: Completeness;
  byResource: ResourceCostDelta[];
  unpriced: PreviewUnknown[];
}

export interface AvailabilityDelta {
  /** Composite availability as a fraction, for example 0.9995. */
  before: number;
  after: number;
  delta: number;
  /** Per month, the window every AWS commitment is measured over. */
  downtimeMinutesBefore: number;
  downtimeMinutesAfter: number;
  weakestBefore: string;
  weakestAfter: string;
  completeness: Completeness;
  unmodelled: PreviewUnknown[];
}

export interface FindingDelta {
  appeared: RuleFinding[];
  resolved: RuleFinding[];
  /** Findings present on both sides. Counted rather than listed. */
  unchangedCount: number;
  /**
   * Resources whose kind has no contract, so no rule could have fired for them.
   * The other two dimensions carry their unknowns on the delta they belong to
   * and this one has nowhere else to put them, which would leave "no rules
   * fired" and "no rules exist" looking identical on a diff card.
   */
  unruled: PreviewUnknown[];
}

export interface PatchPreview {
  previewVersion: typeof PATCH_PREVIEW_VERSION;
  basedOnIrDigest: string;
  patchDigest: string;
  /** False when the patch does not apply. Every delta is then zero and `problems` says why. */
  applicable: boolean;
  problems: PatchProblem[];
  touchedNodeIds: string[];
  cost: CostDelta;
  availability: AvailabilityDelta;
  findings: FindingDelta;
  /** Every assumption either side depended on, so a figure can be argued with. */
  assumptions: Assumption[];
  baselineCacheHit: boolean;
  computedMs: number;
}

export interface PreviewResult {
  preview: PatchPreview;
  /** `invertPatch` against the pre-patch document. Null when the patch does not apply. */
  inverse: IrPatch | null;
  /**
   * The patched document itself, so that applying later is a write of the exact
   * bytes that were priced rather than a second application that has to agree
   * with this one.
   */
  patchedIr: ArchitectureIr | null;
  patchedIrDigest: string | null;
}

export interface PreviewContext {
  region: string;
  assumptions: Assumption[];
  baselineCache: BaselineCache;
  previewCache: PreviewCache;
}

/** Cost, availability and rules over one document, which every proposal against it shares. */
export interface PatchBaseline {
  cost: Prediction<ArchitectureCost>;
  availability: Prediction<AvailabilityReport>;
  findings: NodeFinding[];
  unruled: { resourceId: string; kind: ResourceKind }[];
}

export function previewContext(region: string, assumptions?: Assumption[]): PreviewContext {
  return {
    region,
    assumptions: assumptions ?? [...defaultAssumptions().values()],
    baselineCache: createBaselineCache(),
    previewCache: createPreviewCache(),
  };
}

function assumptionSet(ctx: PreviewContext): AssumptionSet {
  return new Map(ctx.assumptions.map((assumption) => [assumption.id, assumption]));
}

function computeBaseline(ir: ArchitectureIr, ctx: PreviewContext): PatchBaseline {
  const assumptions = assumptionSet(ctx);
  const coverage = ruleCoverage(ir);
  return {
    cost: costArchitecture(ir, { region: ctx.region, assumptions }),
    availability: availability(ir, { region: ctx.region, assumptions }),
    findings: coverage.findings,
    unruled: coverage.unruled,
  };
}

function kindsOf(ir: ArchitectureIr): Map<string, ResourceKind> {
  return new Map(ir.nodes.map((node: IrNode) => [node.id, node.kind]));
}

/** `costModel` prefixes each reason with the resource id; the user reads the reason. */
function withoutIdPrefix(resourceId: string, reason: string): string {
  return reason.startsWith(`${resourceId}: `) ? reason.slice(resourceId.length + 2) : reason;
}

function sameLine(left: CostLine, right: CostLine): boolean {
  return (
    left.label === right.label &&
    left.quantity === right.quantity &&
    left.unitPriceUsd === right.unitPriceUsd &&
    left.monthlyUsd === right.monthlyUsd
  );
}

function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function costDelta(
  before: ArchitectureCost,
  after: ArchitectureCost,
  kinds: Map<string, ResourceKind>
): CostDelta {
  const beforeById = new Map(before.byResource.map((resource) => [resource.resourceId, resource]));
  const afterById = new Map(after.byResource.map((resource) => [resource.resourceId, resource]));

  const byResource: ResourceCostDelta[] = [];
  for (const resourceId of [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()) {
    const wasCosted = beforeById.get(resourceId);
    const isCosted = afterById.get(resourceId);
    const monthlyUsdBefore = wasCosted?.monthlyUsd ?? 0;
    const monthlyUsdAfter = isCosted?.monthlyUsd ?? 0;

    const change =
      wasCosted === undefined ? 'added' : isCosted === undefined ? 'removed' : 'changed';
    const lines =
      change === 'added'
        ? (isCosted?.lines ?? [])
        : change === 'removed'
          ? (wasCosted?.lines ?? [])
          : movedLines(wasCosted?.lines ?? [], isCosted?.lines ?? []);

    if (change === 'changed' && lines.length === 0 && monthlyUsdBefore === monthlyUsdAfter) {
      continue;
    }
    byResource.push({
      resourceId,
      change,
      monthlyUsdBefore,
      monthlyUsdAfter,
      monthlyUsdDelta: round(monthlyUsdAfter - monthlyUsdBefore),
      lines,
    });
  }

  const unpriced = unknownsFrom(before, after, kinds);
  return {
    monthlyUsdBefore: before.monthlyUsd,
    monthlyUsdAfter: after.monthlyUsd,
    monthlyUsdDelta: round(after.monthlyUsd - before.monthlyUsd),
    completeness: unpriced.length === 0 ? 'complete' : 'partial',
    byResource,
    unpriced,
  };
}

/** The after-side lines that differ, plus the before-side lines that vanished. */
function movedLines(before: CostLine[], after: CostLine[]): CostLine[] {
  const moved = after.filter(
    (line) => !before.some((earlier) => earlier.label === line.label && sameLine(earlier, line))
  );
  const gone = before.filter((line) => !after.some((later) => later.label === line.label));
  return [...moved, ...gone];
}

function unknownsFrom(
  before: ArchitectureCost,
  after: ArchitectureCost,
  kinds: Map<string, ResourceKind>
): PreviewUnknown[] {
  const reasons = new Map<string, { resourceId: string; reason: string; sides: Set<string> }>();

  for (const [side, cost] of [
    ['before', before],
    ['after', after],
  ] as const) {
    for (const resource of cost.byResource) {
      for (const raw of resource.unpriced) {
        const reason = withoutIdPrefix(resource.resourceId, raw);
        const key = `${resource.resourceId}\u0000${reason}`;
        const existing = reasons.get(key);
        if (existing === undefined) {
          reasons.set(key, { resourceId: resource.resourceId, reason, sides: new Set([side]) });
        } else {
          existing.sides.add(side);
        }
      }
    }
  }

  return [...reasons.values()]
    .map((entry) => ({
      resourceId: entry.resourceId,
      kind: kinds.get(entry.resourceId) ?? ('vpc' as ResourceKind),
      dimension: 'cost' as const,
      reason: entry.reason,
      side: sideOf(entry.sides),
    }))
    .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
}

function sideOf(sides: ReadonlySet<string>): PreviewUnknown['side'] {
  if (sides.has('before') && sides.has('after')) return 'both';
  return sides.has('before') ? 'before' : 'after';
}

function availabilityDelta(
  before: AvailabilityReport,
  after: AvailabilityReport,
  kinds: Map<string, ResourceKind>
): AvailabilityDelta {
  const sides = new Map<string, Set<string>>();
  for (const [side, report] of [
    ['before', before],
    ['after', after],
  ] as const) {
    for (const resourceId of report.unmodelled) {
      const existing = sides.get(resourceId);
      if (existing === undefined) sides.set(resourceId, new Set([side]));
      else existing.add(side);
    }
  }

  const unmodelled: PreviewUnknown[] = [...sides.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([resourceId, present]) => {
      const kind = kinds.get(resourceId) ?? ('vpc' as ResourceKind);
      return {
        resourceId,
        kind,
        dimension: 'availability' as const,
        reason: `no published SLA and no reliability model for ${kind}`,
        side: sideOf(present),
      };
    });

  return {
    before: before.compositeAvailability,
    after: after.compositeAvailability,
    delta: after.compositeAvailability - before.compositeAvailability,
    downtimeMinutesBefore: before.downtimeMinutesPerMonth,
    downtimeMinutesAfter: after.downtimeMinutesPerMonth,
    weakestBefore: before.weakest,
    weakestAfter: after.weakest,
    completeness: unmodelled.length === 0 ? 'complete' : 'partial',
    unmodelled,
  };
}

function findingDelta(before: PatchBaseline, after: PatchBaseline | null): FindingDelta {
  const beforeKeys = new Set(before.findings.map(findingKey));
  const afterFindings = after?.findings ?? before.findings;
  const afterKeys = new Set(afterFindings.map(findingKey));

  return {
    appeared:
      after === null
        ? []
        : afterFindings.filter((entry) => !beforeKeys.has(findingKey(entry))).map((e) => e.finding),
    resolved:
      after === null
        ? []
        : before.findings
            .filter((entry) => !afterKeys.has(findingKey(entry)))
            .map((e) => e.finding),
    unchangedCount: before.findings.filter((entry) => afterKeys.has(findingKey(entry))).length,
    unruled: ruleUnknowns(before, after),
  };
}

function ruleUnknowns(baseline: PatchBaseline, patched: PatchBaseline | null): PreviewUnknown[] {
  const sides = new Map<string, { kind: ResourceKind; sides: Set<string> }>();
  const record = (side: string, entries: PatchBaseline['unruled']): void => {
    for (const entry of entries) {
      const existing = sides.get(entry.resourceId);
      if (existing === undefined) {
        sides.set(entry.resourceId, { kind: entry.kind, sides: new Set([side]) });
      } else {
        existing.sides.add(side);
      }
    }
  };
  record('before', baseline.unruled);
  if (patched !== null) record('after', patched.unruled);

  return [...sides.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([resourceId, entry]) => ({
      resourceId,
      kind: entry.kind,
      dimension: 'rules' as const,
      reason: `no resource contract for ${entry.kind}, so no rule could have been evaluated`,
      side: sideOf(entry.sides),
    }));
}

function assumptionsOf(...predictions: Prediction<unknown>[]): Assumption[] {
  const byId = new Map<string, Assumption>();
  for (const prediction of predictions) {
    for (const assumption of prediction.assumptions) byId.set(assumption.id, assumption);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Apply, predict, diff. Never mutates `ir`, opens no socket and reads no
 * database. An empty `patch.ops` is legal and returns the baseline with every
 * delta zero, which is how a caller asks what the architecture costs today.
 */
export function previewPatch(
  ir: ArchitectureIr,
  patch: IrPatch,
  ctx: PreviewContext
): PreviewResult {
  const started = performance.now();
  const digest = irDigest(ir);
  const patchIdentity = patchDigest(patch);

  const cached = ctx.previewCache.get(previewKey(digest, patchIdentity, ctx));
  // Returned as it was stored, so two previews of the same patch against the
  // same document are byte-identical rather than merely equal.
  if (cached !== undefined) return cached;

  const key = baselineKey(digest, ctx);
  const cachedBaseline = ctx.baselineCache.get(key);
  const baselineCacheHit = cachedBaseline !== undefined;
  const baseline = cachedBaseline ?? computeBaseline(ir, ctx);
  if (!baselineCacheHit) ctx.baselineCache.set(key, baseline);

  const applied = applyPatch(ir, patch);
  const kinds = kindsOf(ir);

  if (!applied.ok) {
    const result: PreviewResult = {
      preview: {
        previewVersion: PATCH_PREVIEW_VERSION,
        basedOnIrDigest: digest,
        patchDigest: patchIdentity,
        applicable: false,
        problems: applied.problems,
        touchedNodeIds: [],
        // The baseline figures are still true of the document, so they are
        // reported; every delta is zero because nothing was applied.
        cost: costDelta(baseline.cost.value, baseline.cost.value, kinds),
        availability: availabilityDelta(
          baseline.availability.value,
          baseline.availability.value,
          kinds
        ),
        findings: findingDelta(baseline, null),
        assumptions: assumptionsOf(baseline.cost, baseline.availability),
        baselineCacheHit,
        computedMs: elapsed(started),
      },
      inverse: null,
      patchedIr: null,
      patchedIrDigest: null,
    };
    ctx.previewCache.set(previewKey(digest, patchIdentity, ctx), result);
    return result;
  }

  const patched = computeBaseline(applied.ir, ctx);
  const patchedKinds = kindsOf(applied.ir);
  for (const [id, kind] of patchedKinds) kinds.set(id, kind);

  const result: PreviewResult = {
    preview: {
      previewVersion: PATCH_PREVIEW_VERSION,
      basedOnIrDigest: digest,
      patchDigest: patchIdentity,
      applicable: true,
      problems: [],
      touchedNodeIds: applied.touchedNodeIds,
      cost: costDelta(baseline.cost.value, patched.cost.value, kinds),
      availability: availabilityDelta(
        baseline.availability.value,
        patched.availability.value,
        kinds
      ),
      findings: findingDelta(baseline, patched),
      assumptions: assumptionsOf(
        baseline.cost,
        baseline.availability,
        patched.cost,
        patched.availability
      ),
      baselineCacheHit,
      computedMs: elapsed(started),
    },
    inverse: invertPatch(ir, patch),
    patchedIr: applied.ir,
    patchedIrDigest: irDigest(applied.ir),
  };

  ctx.previewCache.set(previewKey(digest, patchIdentity, ctx), result);
  return result;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}
