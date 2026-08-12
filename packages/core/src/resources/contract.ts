import type { IrNode, ResourceKind } from '@infracanvas/ir-schema';

/**
 * One interface holding every answer a downstream feature needs about a
 * resource: what it costs, what it adds to latency, what it does to
 * availability, which Well-Architected rules apply, and what infrastructure
 * code it emits.
 *
 * Answering those questions resource by resource in whichever module happened
 * to need the answer is how this codebase acquired a Pulumi emitter inside a
 * 500-line switch and no cost model at all. Gathering them here means a
 * resource missing its latency model cannot be registered, rather than being
 * registered and silently contributing zero.
 */

export type ParamsOf<K extends ResourceKind> = Extract<IrNode, { kind: K }>['params'];

/** Traffic and size assumptions a model needs. Supplied by the caller, never guessed. */
export interface UsageAssumptions {
  hoursPerMonth: number;
  requestsPerMonth: number;
  averageRequestKb: number;
  storageGb: number;
  region: string;
}

/** A month of continuous operation, which is what an always-on resource bills for. */
export const HOURS_PER_MONTH = 730;

export const DEFAULT_USAGE: UsageAssumptions = {
  hoursPerMonth: HOURS_PER_MONTH,
  requestsPerMonth: 1_000_000,
  averageRequestKb: 8,
  storageGb: 20,
  // Not a client pointed at a region, which is what the rule protects against,
  // but the starting value of an assumption the user is shown and can change.
  // Pricing has to begin somewhere, and beginning in the region with the widest
  // published price coverage is the choice least likely to read as unpriced.
  region: 'us-east-1', // infracanvas-allow: no-hardcoded-region
};

export interface CostComponent {
  label: string;
  /** For example `instance-hour`, `gb-month`, `million-requests`. */
  unit: string;
  quantity: number;
  unitPriceUsd: number;
  monthlyUsd: number;
}

export interface CostEstimate {
  monthlyUsd: number;
  components: CostComponent[];
  /** Identifies the snapshot the prices came from, so a number can be traced to a source. */
  priceSource: { file: string; priceListVersion: string; capturedAt: string };
  /**
   * Parameters the model could not price. Reported rather than assumed free,
   * because a cost that quietly omits a line is worse than one that admits it.
   */
  unpriced: string[];
}

export interface LatencyContribution {
  /** Added to a request that traverses this resource once. */
  p50Ms: number;
  p95Ms: number;
  /** How the numbers were arrived at, shown to the user next to the estimate. */
  basis: string;
}

export interface ReliabilityContribution {
  /** Availability of this resource alone, as a fraction, for example 0.9995. */
  availability: number;
  annualDowntimeMinutes: number;
  /** True when losing this one resource takes the architecture down. */
  singlePointOfFailure: boolean;
}

export type Pillar =
  | 'operational-excellence'
  | 'security'
  | 'reliability'
  | 'performance-efficiency'
  | 'cost-optimisation'
  | 'sustainability';

export type Severity = 'high' | 'medium' | 'low';

export interface RuleFinding {
  ruleId: string;
  pillar: Pillar;
  severity: Severity;
  message: string;
  /** JSON Pointer into the node, so the canvas can highlight the offending field. */
  pointer: string;
  remediation: string;
}

export interface RuleContext {
  /** The node's ancestors, nearest first, so a rule can see which subnet tier it sits in. */
  ancestors: IrNode[];
  region: string;
}

export interface WellArchitectedRule<K extends ResourceKind> {
  id: string;
  pillar: Pillar;
  severity: Severity;
  /** Null when the rule passes. A rule never throws, including on absent parameters. */
  evaluate(params: ParamsOf<K>, context: RuleContext): RuleFinding | null;
}

export interface PulumiFragment {
  /** Deduplicated by the project assembler, for example `import * as aws from "@pulumi/aws";`. */
  imports: string[];
  /** Statements declaring this resource, referencing other nodes through `refFor`. */
  statements: string[];
  exports: string[];
}

export interface EmitContext {
  language: 'typescript';
  /** Variable name for another node's resource. Throws when the node is not in the document. */
  refFor(nodeId: string): string;
  varName: string;
  /** Ancestors nearest first, so an emitter can find the subnets it must attach to. */
  ancestors: IrNode[];
  region: string;
}

export interface ResourceContract<K extends ResourceKind> {
  kind: K;
  /** `$defs` name in the IR schema that types `params`, checked against the schema in tests. */
  paramsDef: string;
  cost(params: ParamsOf<K>, usage: UsageAssumptions): CostEstimate;
  latency(params: ParamsOf<K>): LatencyContribution;
  reliability(params: ParamsOf<K>): ReliabilityContribution;
  rules: WellArchitectedRule<K>[];
  emitPulumi(params: ParamsOf<K>, context: EmitContext): PulumiFragment;
}

/** Raised when an emitter references a node the document does not contain. */
export class EmitReferenceError extends Error {
  constructor(nodeId: string) {
    super(`No resource is emitted for node ${nodeId}, so nothing can reference it.`);
    this.name = 'EmitReferenceError';
  }
}

const MINUTES_PER_YEAR = 365.25 * 24 * 60;

/** Downtime implied by an availability fraction, rounded to the minute a user would quote. */
export function annualDowntimeMinutes(availability: number): number {
  return Math.round((1 - availability) * MINUTES_PER_YEAR * 10) / 10;
}

/** Rounds money to the cent, so a sum of components equals the total exactly. */
export function usd(amount: number): number {
  return Math.round(amount * 100) / 100;
}
