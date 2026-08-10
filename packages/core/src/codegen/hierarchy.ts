/**
 * Turning canvas nesting into something code generation can use.
 *
 * A service drawn inside a private subnet used to generate exactly the same
 * Terraform as the same service dropped on empty canvas: the parent link was
 * stored on the node and then dropped on the floor. That is not a missing
 * feature, it is generated code that contradicts the diagram it came from --
 * the user sees a database inside a private subnet and applies a database that
 * lands wherever the provider defaults put it.
 */
import { getServiceById } from '../aws-services';

export interface HierarchyNode {
  id: string;
  parentNode?: string;
  data: { serviceId: string };
}

/** The containers enclosing a node, by node id. */
export interface Placement {
  vpc?: string;
  subnet?: string;
  cluster?: string;
  /** The availability zone the node sits in, which is an argument, not a resource. */
  zone?: string;
}

const SUBNETS = new Set(['public-subnet', 'private-subnet']);
const CLUSTERS = new Set(['ecs-cluster', 'eks-cluster']);

/** Ancestors of a node, innermost first. */
export function ancestors<T extends HierarchyNode>(node: T, nodes: T[]): T[] {
  const chain: T[] = [];
  const seen = new Set<string>([node.id]);
  let current = node;

  while (current.parentNode) {
    const parent = nodes.find((candidate) => candidate.id === current.parentNode);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    chain.push(parent);
    current = parent;
  }

  return chain;
}

/**
 * Which VPC, subnet, cluster and zone a node is inside.
 *
 * Read from the nesting chain rather than from edges, because containment and
 * connection answer different questions: an edge from a service to a VPC would
 * mean traffic, while sitting inside one means residence.
 */
export function placementOf<T extends HierarchyNode>(node: T, nodes: T[]): Placement {
  const placement: Placement = {};

  for (const ancestor of ancestors(node, nodes)) {
    const serviceId = ancestor.data.serviceId;

    if (!placement.subnet && SUBNETS.has(serviceId)) placement.subnet = ancestor.id;
    else if (!placement.cluster && CLUSTERS.has(serviceId)) placement.cluster = ancestor.id;
    else if (!placement.zone && serviceId === 'availability-zone') placement.zone = ancestor.id;
    else if (!placement.vpc && serviceId === 'vpc-environment') placement.vpc = ancestor.id;
  }

  return placement;
}

/**
 * Nodes ordered so a container always precedes what it contains.
 *
 * Terraform resolves references regardless of order, but a human reading the
 * output should meet the VPC before the subnet that is inside it, and Pulumi
 * genuinely needs the variable declared first.
 */
export function containersFirst<T extends HierarchyNode>(nodes: T[]): T[] {
  const ordered: T[] = [];
  const placed = new Set<string>();

  const place = (node: T, guard: Set<string>) => {
    if (placed.has(node.id)) return;
    // A cycle can only come from corrupted state, and emitting the node once is
    // a better failure than never terminating.
    if (guard.has(node.id)) return;
    guard.add(node.id);

    if (node.parentNode) {
      const parent = nodes.find((candidate) => candidate.id === node.parentNode);
      if (parent) place(parent, guard);
    }

    placed.add(node.id);
    ordered.push(node);
  };

  for (const node of nodes) place(node, new Set<string>());

  return ordered;
}

/** Whether a node's service produces a resource at all. */
export function isProvisionable(serviceId: string): boolean {
  const service = getServiceById(serviceId);
  return Boolean(service?.iac.terraformResource);
}

/** The parent arguments a service wants, as declared in the catalog. */
export function parentLinks(
  serviceId: string
): { argument: string; from: 'subnet' | 'vpc' | 'cluster' }[] {
  return getServiceById(serviceId)?.iac.fromParent ?? [];
}
