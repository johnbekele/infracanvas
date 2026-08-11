import type { ArchitectureIr, IrEdge, IrNode, ResourceKind } from '@infracanvas/ir-schema';

import { kindToServiceId } from '../../ir/kind-map';
import { getResourceContract } from '../../resources/registry';
import { defaultAssumptions, type AssumptionSet } from '../assumptions';
import { predicted, type Assumption, type Prediction } from '../prediction';
import { findSla } from './slas';

/**
 * Availability from the architecture rather than from optimism. Everything a
 * request passes through is in series, so the availabilities multiply and the
 * answer is worse than the worst component; replicas across availability zones
 * are in parallel, so the architecture survives while any one of them stands.
 *
 * The series half is the useful half. It makes visible that putting a cache in
 * front of a database lowers availability unless the application can survive
 * the cache being gone, which is the opposite of what adding a component feels
 * like it should do.
 */

/** Thirty days, the window every AWS SLA is measured over. */
export const MINUTES_PER_MONTH = 43_200;

export const DEFAULT_AZ_CORRELATION = 0.1;

export const SLO_LADDER = [0.99, 0.995, 0.999, 0.9995, 0.9999] as const;

export interface AvailabilityNode {
  resourceId: string;
  serviceId: string;
  configuration: string;
  availability: number;
  /** `published` when an SLA covers this configuration exactly. */
  basis: 'published' | 'modelled';
  azCount: number;
}

export interface AvailabilityReport {
  compositeAvailability: number;
  downtimeMinutesPerMonth: number;
  /** Resource id with the lowest availability on the path. Empty when nothing could be modelled. */
  weakest: string;
  nodes: AvailabilityNode[];
  /** Resources with no published SLA and no modelled value. */
  unmodelled: string[];
}

export interface AvailabilityContext {
  region: string;
  assumptions: AssumptionSet;
}

export function availabilityContext(region = 'us-east-1'): AvailabilityContext {
  return { region, assumptions: defaultAssumptions() };
}

/**
 * Kinds that carry no availability of their own. A VPC, a subnet, a security
 * group, an IAM role and an ECS cluster are configuration rather than running
 * infrastructure: there is no data plane in them that can fail while the
 * services inside them stay up. An internet gateway joins them because AWS
 * documents it as horizontally scaled and redundant with no availability risk,
 * and a log group is where a request's traces go rather than a step the request
 * takes.
 *
 * Excluding them is a claim, not an oversight, which is why the list is short
 * and each member earns its place. Anything else absent from the SLA table and
 * from the contract registry is reported as unmodelled instead.
 */
const NON_SERVING_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  'vpc',
  'subnet',
  'security_group',
  'iam_role',
  'internet_gateway',
  'cloudwatch_log_group',
  'ecs_cluster',
]);

/** Availability zone a resource sits in, when the architecture places it in one. */
const UNPLACED = 'unplaced';

export function seriesAvailability(values: readonly number[]): number {
  return values.reduce((product, value) => product * value, 1);
}

/**
 * `1 - [ (1 - c) * product(1 - a_i) + c * (1 - min(a_i)) ]`, where `c` is the
 * share of failures modelled as hitting every replica at once.
 *
 * At `c = 0` this is exactly the textbook independent-failure formula, which
 * is what makes the assumption arguable: set it to zero and the eight-nines
 * answer comes back, so the difference between the two is visible rather than
 * baked into a constant. At `c = 1` redundancy buys nothing and the group is
 * worth its worst arm, which is what a region-wide event actually does.
 */
export function parallelAvailability(arms: readonly number[], correlation: number): number {
  const first = arms[0];
  if (first === undefined) return 1;
  let independent = 1;
  let worst = first;
  for (const arm of arms) {
    independent *= 1 - arm;
    if (arm < worst) worst = arm;
  }
  return 1 - ((1 - correlation) * independent + correlation * (1 - worst));
}

interface Resolved {
  node: IrNode;
  serviceId: string;
  configuration: string;
  availability: number;
  basis: 'published' | 'modelled';
}

/**
 * The configuration a commitment is looked up by, read from the resource's own
 * parameters and nothing else.
 *
 * Deriving it from how many zones the canvas happens to spread copies over
 * would conflate two different things: AWS's Multi-AZ commitment covers one
 * resource that spans zones internally, whereas three resources drawn in three
 * subnets are three resources composed in parallel. Keeping the two apart is
 * what stops the model claiming a published figure for a topology no SLA
 * covers, and what stops it computing a figure where a commitment already
 * exists.
 *
 * A load balancer is the one case where the parameters are silent and the
 * answer is still not in doubt. An Application Load Balancer is a regional
 * resource, and the IR gives it a parent subnet for layout rather than as its
 * attachment list, so the Multi-AZ commitment is the one that applies.
 */
function configurationFor(node: IrNode): string {
  switch (node.kind) {
    case 'rds_instance':
      return node.params.multiAz === true ? 'multi-az' : 'single-az';
    case 'elasticache_cluster':
      return node.params.multiAz === true ? 'multi-az' : 'single-az';
    case 'alb':
    case 'nlb':
      return 'multi-az';
    case 'ec2_instance':
      return 'single-instance';
    case 'dynamodb_table':
      return node.params.globalTables === true ? 'global-tables' : 'standard';
    case 's3_bucket':
      return 'standard';
    default:
      return 'default';
  }
}

/**
 * A published commitment wins over anything the resource contract models.
 * Deriving 99.9975% for a deployment AWS will only stand behind at 99.95%
 * produces a figure that cannot be defended in an incident review, and figures
 * that can be is the whole point.
 */
function resolve(node: IrNode): Resolved | null {
  const serviceId = kindToServiceId(node.kind) ?? node.kind;
  const configuration = configurationFor(node);

  const sla = findSla(serviceId, configuration);
  if (sla !== undefined) {
    return { node, serviceId, configuration, availability: sla.monthlyUptime, basis: 'published' };
  }

  const contract = getResourceContract(node.kind);
  if (contract === undefined) return null;
  // The registry is heterogeneous by construction; the lookup by `node.kind`
  // is what pairs the params with the contract that types them.
  const modelled = contract.reliability(node.params as never);
  return {
    node,
    serviceId,
    configuration,
    availability: modelled.availability,
    basis: 'modelled',
  };
}

/**
 * Two resources are replicas of one another when they are the same kind and the
 * rest of the architecture talks to them identically, because that is exactly
 * what makes one able to serve while the other is gone. A resource nothing is
 * wired to is its own group: forty unconnected databases are forty databases,
 * not one database with thirty-nine spares, and grouping them would be the most
 * flattering possible reading of a drawing nobody finished.
 */
function groupKeyFor(node: IrNode, peers: ReadonlyMap<string, string>): string {
  const peer = peers.get(node.id);
  return peer === undefined ? `\u0000${node.id}` : `${node.kind}\u0000${peer}`;
}

function peerIndex(edges: readonly IrEdge[]): Map<string, string> {
  const byNode = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    add(byNode, edge.source, edge.target);
    add(byNode, edge.target, edge.source);
  }
  return new Map([...byNode].map(([id, peers]) => [id, [...peers].sort().join(',')]));
}

function add(index: Map<string, Set<string>>, id: string, peer: string): void {
  const existing = index.get(id);
  if (existing === undefined) index.set(id, new Set([peer]));
  else existing.add(peer);
}

/** The zone of the nearest subnet the resource sits inside, directly or through a cluster. */
function zoneOf(node: IrNode, byId: ReadonlyMap<string, IrNode>): string {
  let current: IrNode | undefined = node;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    if (current.kind === 'subnet') return current.params.availabilityZone;
    seen.add(current.id);
    current = current.parent == null ? undefined : byId.get(current.parent);
  }
  return UNPLACED;
}

/**
 * One parallel arm per zone, and within a zone the members multiply.
 *
 * Distinct zones are the only evidence the model has that two resources can
 * stand in for one another; two the graph cannot tell apart in the same zone
 * are far more likely to be two things a request needs than one thing with a
 * spare. Multiplying them is the reading that cannot flatter, and a zone
 * failing takes both either way.
 */
function armsOf(
  members: readonly Resolved[],
  byId: ReadonlyMap<string, IrNode>
): Map<string, number> {
  const arms = new Map<string, number>();
  for (const member of members) {
    const zone = zoneOf(member.node, byId);
    arms.set(zone, (arms.get(zone) ?? 1) * member.availability);
  }
  return arms;
}

function correlationFrom(assumptions: AssumptionSet): number {
  return assumptions.get('availability.azCorrelation')?.value ?? DEFAULT_AZ_CORRELATION;
}

export function availability(
  document: ArchitectureIr,
  ctx: AvailabilityContext = availabilityContext()
): Prediction<AvailabilityReport> {
  const correlation = correlationFrom(ctx.assumptions);
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const peers = peerIndex(document.edges);

  const groups = new Map<string, Resolved[]>();
  const unmodelled: string[] = [];
  const gaps: string[] = [];

  for (const node of document.nodes) {
    if (NON_SERVING_KINDS.has(node.kind)) continue;
    const resolved = resolve(node);
    if (resolved === null) {
      unmodelled.push(node.id);
      gaps.push(
        `Left out of the composite, ${node.id}: no published SLA and no reliability model for ${node.kind}, so the composite is better than the architecture is.`
      );
      continue;
    }
    const key = groupKeyFor(node, peers);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [resolved]);
    else existing.push(resolved);
  }

  const nodes: AvailabilityNode[] = [];
  const groupValues: number[] = [];
  let anyParallel = false;

  for (const members of groups.values()) {
    const arms = armsOf(members, byId);
    groupValues.push(parallelAvailability([...arms.values()], correlation));
    if (arms.size > 1) anyParallel = true;
    if (members.length > 1 && arms.has(UNPLACED)) {
      gaps.push(
        `${members.length} ${members[0]?.serviceId ?? 'resources'} resources are wired identically but not placed in an availability zone, so they are modelled as all being needed rather than as standing in for one another.`
      );
    }
    for (const member of members) {
      nodes.push({
        resourceId: member.node.id,
        serviceId: member.serviceId,
        configuration: member.configuration,
        availability: member.availability,
        basis: member.basis,
        azCount: arms.size,
      });
    }
  }

  if (nodes.length === 0) {
    gaps.push(
      'Nothing on the request path could be modelled, so the composite availability below is an empty product rather than a prediction.'
    );
  }

  const compositeAvailability = seriesAvailability(groupValues);
  const report: AvailabilityReport = {
    compositeAvailability,
    downtimeMinutesPerMonth: downtimeMinutes(compositeAvailability),
    weakest: weakestOf(nodes),
    // Reported in document order rather than group order, so the panel lists
    // resources where the user drew them.
    nodes: inDocumentOrder(nodes, document.nodes),
    unmodelled,
  };

  // The correlation only moves an architecture that has something in parallel.
  // Reporting it on one that does not would offer the user a setting that
  // changes nothing, which is worse than not offering it.
  const assumptions: Assumption[] = [];
  if (anyParallel) {
    const correlationAssumption = ctx.assumptions.get('availability.azCorrelation');
    if (correlationAssumption !== undefined) assumptions.push(correlationAssumption);
  }

  return predicted(report, assumptions, gaps);
}

/** Rounded to the tenth of a minute a user would quote, matching `annualDowntimeMinutes`. */
function downtimeMinutes(value: number): number {
  return Math.round((1 - value) * MINUTES_PER_MONTH * 10) / 10;
}

function weakestOf(nodes: readonly AvailabilityNode[]): string {
  let weakest: AvailabilityNode | undefined;
  for (const node of nodes) {
    if (weakest === undefined || node.availability < weakest.availability) weakest = node;
  }
  return weakest?.resourceId ?? '';
}

function inDocumentOrder(
  nodes: readonly AvailabilityNode[],
  document: readonly IrNode[]
): AvailabilityNode[] {
  const position = new Map(document.map((node, index) => [node.id, index]));
  return [...nodes].sort(
    (a, b) => (position.get(a.resourceId) ?? 0) - (position.get(b.resourceId) ?? 0)
  );
}
