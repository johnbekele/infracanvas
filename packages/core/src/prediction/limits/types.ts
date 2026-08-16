import type { IrNode } from '@infracanvas/ir-schema';

import type { AssumptionSet } from '../assumptions';

/**
 * A limit is data with a citation rather than a branch in code.
 *
 * AWS moves these numbers, and a limit encoded as an `if` inside a solver is one
 * nobody will ever find to update. Carrying the value, its unit, whether Service
 * Quotas can raise it, the page it was read from and the day it was read also
 * lets a report say "raise this quota" instead of "redesign this", which is
 * usually the correct advice and costs nothing.
 */
export interface ServiceLimit {
  /** Dotted and stable, for example `lambda.concurrentExecutions`. */
  id: string;
  /** The catalogue service the limit belongs to, or `*` for one that is not a quota at all. */
  serviceId: string;
  label: string;
  value: number;
  unit: string;
  /** True when Service Quotas can raise it, which changes the remedy. */
  adjustable: boolean;
  /** The Service Quotas code, for example `L-B99A9384`. Null when there is none. */
  quotaCode: string | null;
  /** Documentation URL the value was read from. */
  source: string;
  /** ISO date the value was read. AWS changes these. */
  retrievedAt: string;
  /** False for a resource whose configuration the limit does not cover. Applies to all by default. */
  appliesTo?(resource: IrNode): boolean;
  /**
   * The limit for one resource, where its own parameters decide it. Deviation
   * from the issue, which has a single `value`: an RDS instance's connection
   * ceiling is a formula over the memory of its instance class, and publishing
   * the five thousand a large instance reaches as the limit of a `db.t3.micro`
   * would over-promise by a factor of fifty.
   */
  limitFor?(resource: IrNode): number;
  /** Must be non-decreasing in `rps`; asserted for every limit by test. */
  usageAt(resource: IrNode, rps: number, ctx: BottleneckContext): number;
}

export interface BottleneckContext {
  assumptions: AssumptionSet;
  /** The rate the architecture is asked to hold. Headroom is measured from it. */
  targetRps: number;
  /** Ids the target rate came from. Empty when the caller chose the rate itself. */
  targetAssumptionIds: readonly string[];
}

/** Serving capacity belongs to no AWS service, so it matches every resource that queues. */
export const ANY_SERVICE = '*';
