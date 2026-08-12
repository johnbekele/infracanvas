import {
  DEFAULT_USAGE,
  IR_VERSION,
  serviceIdToKind,
  type ArchitectureIr,
  type IrNode,
  type ResourceKind,
  type ServiceNodeData,
} from '@infracanvas/core';
import type { Edge, Node } from 'reactflow';

/**
 * The canvas store still holds the pre-IR node shape: a catalogue `serviceId`
 * and a flat `properties` bag whose keys were chosen per service, years before
 * anything read them. Everything that predicts, checks or emits now reads the
 * IR instead, so this is the one place the old shape is translated into the new
 * one.
 *
 * It is a bridge and it is meant to be temporary: when the store holds IR nodes
 * directly this file goes away rather than growing. That is why the translation
 * is a table of small functions instead of a framework - there is no second
 * caller to generalise for.
 */

export interface ConversionResult {
  document: ArchitectureIr;
  /** Nodes left out, with the reason, so a total can say what it did not count. */
  skipped: { id: string; name: string; reason: string }[];
}

type Properties = Record<string, string | number | boolean>;

function text(properties: Properties, key: string): string | undefined {
  const value = properties[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integer(properties: Properties, key: string): number | undefined {
  const value = properties[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function flag(properties: Properties, key: string): boolean | undefined {
  const value = properties[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Only kinds whose parameters the schema types need a projection. Everything
 * else carries its properties through as the untyped bag the schema still
 * allows, which is exactly what those kinds are waiting for a contract to
 * replace.
 */
const PROJECTIONS: Partial<Record<ResourceKind, (properties: Properties) => object | null>> = {
  rds_instance: (properties) => {
    const engine = text(properties, 'engine');
    const instanceClass = text(properties, 'instanceClass');
    const allocatedStorageGb = integer(properties, 'allocatedStorage');
    // The three required parameters have catalogue defaults, so an absent one
    // means the node predates the property rather than that the user cleared
    // it. Refusing is better than inventing a database to price.
    if (engine === undefined || instanceClass === undefined || allocatedStorageGb === undefined) {
      return null;
    }
    return {
      engine,
      instanceClass,
      // The schema's floor is the smallest allocation RDS will provision, and a
      // saved design can hold a smaller number from before that was checked.
      allocatedStorageGb: Math.max(20, allocatedStorageGb),
      ...maybe('multiAz', flag(properties, 'multiAz')),
      ...maybe('publiclyAccessible', flag(properties, 'publiclyAccessible')),
      ...maybe('deletionProtection', flag(properties, 'deletionProtection')),
    };
  },
  vpc: (properties) => ({
    cidrBlock: text(properties, 'cidrBlock') ?? '10.0.0.0/16',
    enableDnsHostnames: flag(properties, 'enableDnsHostnames') ?? true,
    enableDnsSupport: flag(properties, 'enableDnsSupport') ?? true,
  }),
  subnet: (properties) => {
    const cidrBlock = text(properties, 'cidrBlock');
    const availabilityZone = text(properties, 'availabilityZone');
    // The zone is what tells the availability model whether two replicas can
    // fail together, so a subnet without one is skipped rather than given a
    // plausible zone that would quietly decide the answer.
    if (cidrBlock === undefined || availabilityZone === undefined) return null;
    return {
      tier: text(properties, 'tier') === 'public' ? 'public' : 'private',
      cidrBlock,
      availabilityZone,
    };
  },
};

function maybe<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** Subnets are drawn as one of two catalogue entries, and the tier is which one. */
function tierOf(serviceId: string, properties: Properties): Properties {
  if (serviceId !== 'public-subnet' && serviceId !== 'private-subnet') return properties;
  return { ...properties, tier: serviceId === 'public-subnet' ? 'public' : 'private' };
}

export function canvasStoreToIr(
  nodes: Node<ServiceNodeData>[],
  edges: Edge[],
  options: { name?: string; region?: string } = {}
): ConversionResult {
  const skipped: ConversionResult['skipped'] = [];
  const irNodes: IrNode[] = [];

  for (const node of nodes) {
    const serviceId = node.data.serviceId;
    const kind = serviceIdToKind(serviceId);
    if (kind === undefined) {
      skipped.push({
        id: node.id,
        name: node.data.serviceName,
        reason: `${serviceId} has no place in the architecture model yet`,
      });
      continue;
    }

    const properties = tierOf(serviceId, node.data.properties ?? {});
    const project = PROJECTIONS[kind];
    const params = project === undefined ? properties : project(properties);
    if (params === null) {
      skipped.push({
        id: node.id,
        name: node.data.serviceName,
        reason: 'is missing a setting the model needs',
      });
      continue;
    }

    irNodes.push({
      id: node.id,
      kind,
      name: node.data.serviceName || node.id,
      ...(node.parentNode === undefined ? {} : { parent: node.parentNode }),
      layout: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      params,
    } as IrNode);
  }

  // A parent that was skipped would leave its children referring to a node the
  // document does not contain, which the validator rejects outright.
  const present = new Set(irNodes.map((node) => node.id));
  for (const node of irNodes) {
    if (node.parent != null && !present.has(node.parent)) delete node.parent;
  }

  const document: ArchitectureIr = {
    irVersion: IR_VERSION,
    name: options.name ?? 'Untitled architecture',
    provider: 'aws',
    region: options.region ?? DEFAULT_USAGE.region,
    nodes: irNodes,
    edges: edges
      .filter((edge) => present.has(edge.source) && present.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // The canvas draws one undifferentiated line, so every edge is the
        // weakest claim the schema offers rather than a routing relationship
        // nothing established.
        kind: 'connects' as const,
      })),
    presentation: { viewport: { x: 0, y: 0, zoom: 1 } },
  } as ArchitectureIr;

  return { document, skipped };
}
