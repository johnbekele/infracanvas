import type { IrNode } from '@infracanvas/ir-schema';

import type { EmitContext, ParamsOf, PulumiFragment } from '../contract';

/**
 * An RDS instance is two resources: the instance and the subnet group that
 * decides which subnets it may live in. Emitting the group here rather than
 * leaving it to an assembler keeps the pair together, since an instance whose
 * group names the wrong tier is exactly the mistake the security rule exists to
 * catch and would be invisible in generated code.
 */

/** Quotes for a TypeScript string literal without pulling in a formatter. */
function literal(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function subnetAncestors(ancestors: IrNode[]): IrNode[] {
  return ancestors.filter((node) => node.kind === 'subnet');
}

export function emitPulumi(params: ParamsOf<'rds_instance'>, context: EmitContext): PulumiFragment {
  const subnets = subnetAncestors(context.ancestors);
  if (subnets.length === 0) {
    throw new Error(
      `${context.varName} has no subnet ancestor, so no subnet group can be emitted for it.`
    );
  }

  const groupVar = `${context.varName}Subnets`;
  const subnetIds = subnets.map((subnet) => `${context.refFor(subnet.id)}.id`);

  const args = [
    `engine: ${literal(params.engine)},`,
    ...(params.engineVersion ? [`engineVersion: ${literal(params.engineVersion)},`] : []),
    `instanceClass: ${literal(params.instanceClass)},`,
    `allocatedStorage: ${params.allocatedStorageGb},`,
    `storageType: ${literal(params.storageType ?? 'gp3')},`,
    `multiAz: ${params.multiAz === true},`,
    `publiclyAccessible: ${params.publiclyAccessible === true},`,
    `deletionProtection: ${params.deletionProtection === true},`,
    `backupRetentionPeriod: ${params.backupRetentionDays ?? 7},`,
    `storageEncrypted: ${params.storageEncrypted !== false},`,
    `dbSubnetGroupName: ${groupVar}.name,`,
  ];

  return {
    imports: ['import * as aws from "@pulumi/aws";'],
    statements: [
      `const ${groupVar} = new aws.rds.SubnetGroup(${literal(groupVar)}, {`,
      `  subnetIds: [${subnetIds.join(', ')}],`,
      `});`,
      ``,
      `const ${context.varName} = new aws.rds.Instance(${literal(context.varName)}, {`,
      ...args.map((line) => `  ${line}`),
      `});`,
    ],
    exports: [`export const ${context.varName}Endpoint = ${context.varName}.endpoint;`],
  };
}
