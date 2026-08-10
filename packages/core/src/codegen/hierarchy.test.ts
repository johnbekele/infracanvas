import { describe, expect, it } from 'vitest';
import { ancestors, containersFirst, placementOf } from './hierarchy';
import { generateTerraformProject } from './terraform';
import { generatePulumiProject } from './pulumi';
import type { ServiceNodeData } from '../types';

interface TestNode {
  id: string;
  data: ServiceNodeData;
  position: { x: number; y: number };
  parentNode?: string;
}

function node(id: string, serviceId: string, serviceName: string, parentNode?: string): TestNode {
  return {
    id,
    position: { x: 0, y: 0 },
    parentNode,
    data: {
      serviceId,
      serviceName,
      shortName: serviceName,
      color: '#000000',
      category: 'compute',
      properties: {},
    } as ServiceNodeData,
  };
}

/** A VPC with a private subnet, a cluster inside it, and two API services. */
function nestedDesign(): TestNode[] {
  return [
    node('vpc', 'vpc-environment', 'Production VPC'),
    node('private', 'private-subnet', 'App Subnet', 'vpc'),
    node('cluster', 'ecs-cluster', 'App Cluster', 'private'),
    node('api', 'ecs', 'ECS', 'cluster'),
    node('checkout', 'ecs', 'ECS', 'cluster'),
    node('nat', 'nat-gateway', 'NAT Gateway', 'private'),
  ];
}

describe('placementOf', () => {
  it('finds every enclosing container, not just the immediate one', () => {
    const nodes = nestedDesign();
    const placement = placementOf(nodes[3], nodes);

    expect(placement).toEqual({ cluster: 'cluster', subnet: 'private', vpc: 'vpc' });
  });

  it('reports nothing for a node on open canvas', () => {
    const nodes = nestedDesign();
    expect(placementOf(nodes[0], nodes)).toEqual({});
  });

  it('does not hang on a design whose parent links form a cycle', () => {
    const nodes = [node('a', 'ecs', 'A', 'b'), node('b', 'ecs', 'B', 'a')];
    expect(ancestors(nodes[0], nodes).length).toBeLessThanOrEqual(2);
  });
});

describe('containersFirst', () => {
  it('places a container before everything it contains', () => {
    const nodes = nestedDesign();
    const order = containersFirst(nodes).map((entry) => entry.id);

    expect(order.indexOf('vpc')).toBeLessThan(order.indexOf('private'));
    expect(order.indexOf('private')).toBeLessThan(order.indexOf('cluster'));
    expect(order.indexOf('cluster')).toBeLessThan(order.indexOf('api'));
  });

  it('emits every node exactly once', () => {
    const nodes = nestedDesign();
    const order = containersFirst(nodes).map((entry) => entry.id);

    expect(order).toHaveLength(nodes.length);
    expect(new Set(order).size).toBe(nodes.length);
  });
});

describe('generated Terraform', () => {
  const project = generateTerraformProject(nestedDesign(), []);
  const main = project.files.find((file) => file.path === 'main.tf')?.content ?? '';

  it('gives two services of the same kind distinct module names', () => {
    const labels = [...main.matchAll(/module "([a-z0-9_]+)"/g)].map((match) => match[1]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('passes the subnet a node is drawn in through to its module', () => {
    expect(main).toMatch(/module "nat_gateway" \{[\s\S]*subnet_id = module\.app_subnet\.id/);
  });

  it('passes the VPC through to the subnet drawn inside it', () => {
    expect(main).toMatch(/module "app_subnet" \{[\s\S]*vpc_id = module\.production_vpc\.id/);
  });

  it('declares the parent variables the modules consume', () => {
    const variables =
      project.files.find((file) => file.path === 'modules/private-subnet/variables.tf')?.content ??
      '';
    expect(variables).toContain('variable "vpc_id"');
  });

  it('exports each module from the resource that module actually declares', () => {
    const outputs =
      project.files.find((file) => file.path === 'modules/private-subnet/outputs.tf')?.content ??
      '';
    expect(outputs).toContain('aws_subnet.this.id');
    expect(outputs).not.toContain('aws_private_subnet');
  });

  it('does not export an id for a construct that generates no resource', () => {
    const zone = generateTerraformProject(
      [node('az', 'availability-zone', 'us-east-1a')],
      []
    ).files.find((file) => file.path === 'modules/availability-zone/outputs.tf')?.content;

    expect(zone).not.toContain('output "id"');
  });
});

describe('generated Pulumi', () => {
  it('gives two services of the same kind distinct variable names', () => {
    const project = generatePulumiProject(nestedDesign(), [], 'typescript');
    const index = project.files.find((file) => file.path === 'index.ts')?.content ?? '';
    const declarations = [...index.matchAll(/const ([a-zA-Z0-9]+) = new aws\./g)].map((m) => m[1]);

    expect(new Set(declarations).size).toBe(declarations.length);
  });

  it('declares a container before the resource that references it', () => {
    const project = generatePulumiProject(nestedDesign(), [], 'python');
    const main = project.files.find((file) => file.path === '__main__.py')?.content ?? '';

    expect(main.indexOf('app_subnet = ')).toBeLessThan(main.indexOf('nat_gateway = '));
  });

  it('references the enclosing subnet from the resource inside it', () => {
    const project = generatePulumiProject(nestedDesign(), [], 'python');
    const main = project.files.find((file) => file.path === '__main__.py')?.content ?? '';

    expect(main).toMatch(/nat_gateway = aws\.ec2\.NatGateway\([\s\S]*subnet_id=app_subnet\.id/);
  });
});
