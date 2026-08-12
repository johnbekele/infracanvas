import {
  type ArchitectureIr,
  availability,
  costArchitecture,
  defaultAssumptions,
  evaluateArchitecture,
  proposeSlos,
  registerBuiltInResources,
  withOverride,
  type ArchitectureCost,
  type ArchitectureFindings,
  type Assumption,
  type AvailabilityReport,
  type Prediction,
  type SloProposal,
} from '@infracanvas/core';

/**
 * Everything the estimate panel shows, computed from one document in one pass.
 *
 * It runs in the browser rather than behind an endpoint because the panel's
 * whole point is that changing an assumption moves the number in front of you.
 * A round trip per keystroke would make the arithmetic feel like a query, and
 * the models are pure functions over a few dozen nodes.
 */

export interface ArchitectureEstimate {
  cost: Prediction<ArchitectureCost>;
  availability: Prediction<AvailabilityReport>;
  slos: Prediction<SloProposal[]>;
  findings: ArchitectureFindings;
  /** Every assumption behind the figures, in one list the panel can edit. */
  assumptions: Assumption[];
}

/**
 * Registration is global and idempotent only by this guard: the module is
 * imported by every component that shows a figure, and registering twice
 * throws by design.
 */
let registered = false;
function ensureContracts(): void {
  if (registered) return;
  registerBuiltInResources();
  registered = true;
}

export function estimateArchitecture(
  document: ArchitectureIr,
  overrides: ReadonlyMap<string, number> = new Map()
): ArchitectureEstimate {
  ensureContracts();

  let assumptions = defaultAssumptions();
  for (const [id, value] of overrides) {
    // An override for an assumption nothing reads throws rather than being
    // silently kept, so a stale saved override surfaces as a bug in the panel
    // rather than as a figure that ignores its own input.
    assumptions = withOverride(assumptions, id, value);
  }

  const region = document.region;
  const cost = costArchitecture(document, { region, assumptions });
  const report = availability(document, { region, assumptions });
  // Zero means no latency objective is proposed. The latency model lands on its
  // own branch, and inventing a p95 here would put a number on the panel that
  // nothing computed.
  const slos = proposeSlos(report.value, { p95Ms: 0 }, report.assumptions);

  return {
    cost,
    availability: report,
    slos,
    findings: evaluateArchitecture(document),
    assumptions: [...assumptions.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
