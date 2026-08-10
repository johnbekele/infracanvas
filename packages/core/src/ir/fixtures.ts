import { readdirSync, readFileSync } from 'node:fs';

import { assertValidIr, type ArchitectureIr, type IrNode } from '@infracanvas/ir-schema';

/**
 * Every valid fixture the schema package ships, read through the same validator
 * a caller would use. Reusing those files rather than restating them here means
 * a fixture cannot drift into describing an architecture the validator rejects.
 *
 * Tests mutate what they get back, so each call returns a fresh copy; sharing
 * one object would make one test's edit another test's input.
 */
const directory = new URL('../../../ir-schema/fixtures/', import.meta.url);

/**
 * Read from disk rather than listed here, so a fixture added to the schema
 * package joins the round-trip suite without anyone remembering to add it.
 */
export function fixtureNames(): string[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
}

export function fixture(name: string): ArchitectureIr {
  return assertValidIr(JSON.parse(readFileSync(new URL(`${name}.json`, directory), 'utf8')));
}

export function threeTier(): ArchitectureIr {
  return fixture('three-tier');
}

/**
 * VPC, subnet, cluster, service: the deepest containment the canvas supports,
 * and the one shape a conversion that flattens parents still gets right at
 * three levels.
 */
export function fourLevelChain(): ArchitectureIr {
  const nodes: IrNode[] = [
    {
      id: 'vpc-main',
      kind: 'vpc',
      name: 'Main VPC',
      layout: { x: 0, y: 0, width: 960, height: 640 },
      params: { cidrBlock: '10.0.0.0/16', enableDnsHostnames: true, enableDnsSupport: true },
    },
    {
      id: 'subnet-private-a',
      kind: 'subnet',
      name: 'Private A',
      parent: 'vpc-main',
      layout: { x: 32, y: 64, width: 420, height: 240 },
      params: { tier: 'private', cidrBlock: '10.0.2.0/24', availabilityZone: 'eu-west-1a' },
    },
    {
      id: 'cluster-main',
      kind: 'ecs_cluster',
      name: 'Main cluster',
      parent: 'subnet-private-a',
      layout: { x: 24, y: 48, width: 300, height: 160 },
      params: {},
    },
    {
      id: 'ecs-api',
      kind: 'ecs_service',
      name: 'API service',
      parent: 'cluster-main',
      layout: { x: 20, y: 48 },
      params: { cpu: 512, memory: 1024, desiredCount: 2 },
    },
  ];

  return assertValidIr({
    irVersion: threeTier().irVersion,
    name: 'Four level containment',
    provider: 'aws',
    region: 'eu-west-1',
    nodes,
    edges: [],
    presentation: { viewport: { x: 0, y: 0, zoom: 1 } },
  });
}
