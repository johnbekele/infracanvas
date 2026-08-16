/**
 * Generating infrastructure code from a catalog entry.
 *
 * The alternative was an emitter per service, hand-written three times over --
 * once for Terraform, once for Pulumi TypeScript, once for Pulumi Python. That
 * is why the catalog stopped at 21 services and why Pulumi Python covered six of
 * them: adding a service meant three edits in three files, so what actually
 * happened was that the export quietly fell through to a placeholder comment for
 * anything newer. A design that punishes adding a service ends up with few.
 *
 * Argument names come from a convention rather than a per-property declaration,
 * because the convention holds almost everywhere: a property named
 * `containerPort` is `container_port` in Terraform and Pulumi Python and
 * `containerPort` in Pulumi TypeScript. A catalog entry declares only where the
 * provider disagrees, or where a property configures the canvas rather than the
 * resource.
 */
import { getServiceById, type AWSService, type IacMapping } from '../aws-services';

export type Target = 'terraform' | 'pulumi-ts' | 'pulumi-python';

export interface EmitNode {
  id: string;
  serviceId: string;
  properties: Record<string, unknown>;
  /** Identifier to generate under. Derived from the id when absent. */
  name?: string;
}

export interface EmitOptions {
  parent?: ParentContext;
  /** The expression holding shared tags in the surrounding file. */
  tags?: string;
  /**
   * Take parent-derived arguments from module variables instead of resources.
   *
   * Inside a Terraform module there is no `aws_subnet` to point at: the subnet
   * lives in the root module, so the id arrives as an input variable.
   */
  parentFromVariables?: boolean;
}

/** What a parent contributes to its children, keyed by the parent's service. */
export interface ParentContext {
  serviceId: string;
  /** The generated resource name of the parent, for referencing its outputs. */
  resourceName: string;
}

export type PropertyValue = string | number | boolean;

function isPropertyValue(value: unknown): value is PropertyValue {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

/** `containerPort` becomes `container_port`; `cpu` stays `cpu`. */
export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** A node id becomes a valid identifier in every target language. */
export function identifierFor(node: EmitNode): string {
  // Split on the separators rather than substituting then trimming them. It
  // drops leading and trailing runs by construction, where trimming with `_+$`
  // backtracks quadratically on an id that is mostly underscores.
  const words = (node.name ?? node.id)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const identifier = words.join('_');

  // A leading digit is legal in a Terraform resource name and not in Python.
  return /^[0-9]/.test(identifier) ? `r_${identifier}` : identifier || 'resource';
}

/** The argument name a property takes in one target, or null when it is not one. */
export function argumentNameFor(iac: IacMapping, property: string, target: Target): string | null {
  const override = iac.overrides?.[property];
  if (override === null) return null;
  if (override) return target === 'terraform' ? override.terraform : override.pulumi;

  return target === 'pulumi-ts' ? property : snakeCase(property);
}

function terraformValue(value: PropertyValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function pythonValue(value: PropertyValue): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

interface Argument {
  name: string;
  value: PropertyValue;
}

/**
 * The arguments a node contributes, in catalog order.
 *
 * Catalog order rather than object order, so two nodes of the same service
 * generate their arguments in the same sequence whatever order the canvas
 * happens to hold their properties in. Generated code that reorders itself
 * between runs produces a diff on every export.
 */
function argumentsFor(service: AWSService, node: EmitNode, target: Target): Argument[] {
  const args: Argument[] = [];

  for (const property of service.properties) {
    const name = argumentNameFor(service.iac, property.name, target);
    if (name === null) continue;

    const value = node.properties[property.name] ?? property.default;
    if (!isPropertyValue(value)) continue;
    // An empty optional string produces `key = ""`, which is not the same as
    // leaving the argument out and is rarely what the provider expects.
    if (value === '' && !property.required) continue;

    args.push({ name, value });
  }

  return args;
}

/**
 * Arguments taken from the container a node sits in.
 *
 * This is the part the previous generator dropped: a service drawn inside a
 * subnet generated code with no subnet reference at all, so the diagram said one
 * thing and the Terraform said another. Placement is not decoration.
 */
function parentArguments(service: AWSService, options: EmitOptions, target: Target): string[] {
  if (!service.iac.fromParent) return [];

  if (options.parentFromVariables) {
    return service.iac.fromParent.map(
      (link) => `${snakeCase(link.argument)} = var.${snakeCase(link.argument)}`
    );
  }

  const parent = options.parent;
  if (!parent) return [];

  const references: string[] = [];

  for (const link of service.iac.fromParent) {
    const matches =
      (link.from === 'subnet' &&
        (parent.serviceId === 'public-subnet' || parent.serviceId === 'private-subnet')) ||
      (link.from === 'vpc' && parent.serviceId === 'vpc-environment') ||
      (link.from === 'cluster' &&
        (parent.serviceId === 'ecs-cluster' || parent.serviceId === 'eks-cluster'));

    if (!matches) continue;

    const argument = target === 'pulumi-ts' ? link.argument : snakeCase(link.argument);
    const parentResource = getServiceById(parent.serviceId)?.iac.terraformResource;
    const reference =
      target === 'terraform'
        ? `${parentResource ?? 'aws_subnet'}.${parent.resourceName}.id`
        : `${parent.resourceName}.id`;

    references.push(`${argument} = ${reference}`);
  }

  return references;
}

/** A Terraform resource block for a node. */
export function emitTerraform(node: EmitNode, options: EmitOptions = {}): string {
  const service = getServiceById(node.serviceId);
  if (!service || !service.iac.terraformResource) return '';

  const name = identifierFor(node);
  const lines = argumentsFor(service, node, 'terraform').map(
    (argument) => `  ${argument.name} = ${terraformValue(argument.value)}`
  );

  for (const reference of parentArguments(service, options, 'terraform')) {
    lines.push(`  ${reference}`);
  }

  if (service.iac.taggable !== false) {
    lines.push(`  tags = ${options.tags ?? 'local.common_tags'}`);
  }

  return [`resource "${service.iac.terraformResource}" "${name}" {`, ...lines, '}', ''].join('\n');
}

/** A Pulumi resource declaration for a node, in TypeScript or Python. */
export function emitPulumi(
  node: EmitNode,
  language: 'typescript' | 'python',
  options: EmitOptions = {}
): string {
  const service = getServiceById(node.serviceId);
  if (!service || !service.iac.pulumiClass) return '';

  const target: Target = language === 'python' ? 'pulumi-python' : 'pulumi-ts';
  const name = identifierFor(node);
  const args = argumentsFor(service, node, target);
  const tags = options.tags ?? 'tags';

  const taggable = service.iac.taggable !== false;

  if (language === 'python') {
    const lines = args.map((argument) => `    ${argument.name}=${pythonValue(argument.value)},`);
    for (const reference of parentArguments(service, options, target)) {
      lines.push(`    ${reference.replace(' = ', '=')},`);
    }
    if (taggable) lines.push(`    tags={**${tags}, "Name": "${name}"},`);

    return [`${name} = ${service.iac.pulumiClass}("${name}",`, ...lines, ')', ''].join('\n');
  }

  const lines = args.map((argument) => `  ${argument.name}: ${JSON.stringify(argument.value)},`);
  for (const reference of parentArguments(service, options, target)) {
    lines.push(`  ${reference.replace(' = ', ': ')},`);
  }
  if (taggable) lines.push(`  tags: { ...${tags}, Name: "${name}" },`);

  return [`const ${name} = new ${service.iac.pulumiClass}("${name}", {`, ...lines, '});', ''].join(
    '\n'
  );
}
