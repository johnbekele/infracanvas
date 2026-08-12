import {
  type ArchitectureIr,
  availability,
  bottleneckContext,
  costArchitecture,
  defaultAssumptions,
  evaluateArchitecture,
  findBottleneck,
  latencyContext,
  pathLatency,
  proposeSlos,
  registerBuiltInResources,
  sequentialPath,
  withOverride,
  type ArchitectureCost,
  type ArchitectureFindings,
  type Assumption,
  type AvailabilityReport,
  type BottleneckReport,
  type IrNode,
  type PathLatency,
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
  /** Null when nothing on the request path could be modelled. */
  latency: Prediction<PathLatency> | null;
  bottleneck: Prediction<BottleneckReport>;
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

  const latency = latencyOf(document, report.value, assumptions);
  const bottleneck = findBottleneck(document.nodes, bottleneckContext(assumptions));

  // A latency objective is proposed only when a path was actually modelled.
  // Passing zero is how `proposeSlos` is told there is none, and it is the
  // honest input when nothing on the path carries a service time.
  const slos = proposeSlos(report.value, { p95Ms: latency?.value.p95Ms ?? 0 }, [
    ...report.assumptions,
    ...(latency?.assumptions ?? []),
  ]);

  return {
    cost,
    availability: report,
    latency,
    bottleneck,
    slos,
    findings: evaluateArchitecture(document),
    assumptions: [...assumptions.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/**
 * The request path is the one the availability model already reasoned about:
 * the resources it put in series are, by its own definition, what a request
 * passes through. Deriving a second path here would let the two models disagree
 * about the shape of the same architecture, and a p95 measured along a
 * different route than the availability figure is two answers about one system.
 */
function latencyOf(
  document: ArchitectureIr,
  report: AvailabilityReport,
  assumptions: ReturnType<typeof defaultAssumptions>
): Prediction<PathLatency> | null {
  const byId = new Map<string, IrNode>(document.nodes.map((node) => [node.id, node]));
  const onPath = report.nodes
    .map((node) => byId.get(node.resourceId))
    .filter((node): node is IrNode => node !== undefined);

  if (onPath.length === 0) return null;
  return pathLatency(sequentialPath(onPath), latencyContext(assumptions));
}
