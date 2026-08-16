import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import schemaJson from '../schema/architecture-ir.schema.json';
import type { ArchitectureIr, PendingContractKind, ResourceKind } from './generated/types.js';
import type { IrNode } from './nodes.js';
import { IR_SCHEMA_ID } from './generated/ir-version.js';

export interface IrProblem {
  /** JSON Pointer into the document, for example `/nodes/3/params/cidrBlock`. */
  pointer: string;
  message: string;
  /** `schema` for a JSON Schema violation, `reference` for the graph rules below. */
  source: 'schema' | 'reference';
}

export type IrValidationResult =
  | { valid: true; document: ArchitectureIr }
  | { valid: false; problems: IrProblem[] };

export class IrValidationError extends Error {
  readonly problems: IrProblem[];

  constructor(problems: IrProblem[]) {
    super(
      `Invalid architecture IR: ${problems.map((p) => `${p.pointer} ${p.message}`).join('; ')}`
    );
    this.name = 'IrValidationError';
    this.problems = problems;
  }
}

/**
 * A CIDR block, checked without a regular expression so the cost is linear in
 * the input regardless of what a caller passes. JSON Schema's built-in formats
 * do not cover CIDR, and accepting `10.0.0/16` at the document boundary means
 * discovering it in generated Terraform instead.
 */
function isIpv4Cidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash < 0 || value.indexOf('/', slash + 1) >= 0) return false;

  const prefix = value.slice(slash + 1);
  if (!isSmallDecimal(prefix, 32)) return false;

  const octets = value.slice(0, slash).split('.');
  return octets.length === 4 && octets.every((octet) => isSmallDecimal(octet, 255));
}

/** A canonical decimal in `0..max`: no sign, no leading zero, no whitespace. */
function isSmallDecimal(text: string, max: number): boolean {
  if (text.length === 0 || text.length > 3) return false;
  if (text.length > 1 && text[0] === '0') return false;
  for (const character of text) {
    if (character < '0' || character > '9') return false;
  }
  return Number(text) <= max;
}

const ajv = new Ajv2020({
  allErrors: true,
  // The pending-contract parameter bag is genuinely a union of scalars.
  allowUnionTypes: true,
  strict: true,
});
ajv.addFormat('ipv4-cidr', { type: 'string', validate: isIpv4Cidr });

// Compiled once at module load. The canvas validates on every save, so paying
// Ajv's compilation cost per call would put it on an interactive path.
const validateDocument = ajv.compile(schemaJson);

/**
 * Per-kind validators. Ajv reports a `oneOf` failure as every branch failing at
 * once, which buries the one error a user can act on under two they cannot. A
 * node is dispatched to the branch its `kind` names so the pointer lands on the
 * offending parameter.
 */
const BRANCH_BY_KIND = new Map<string, ValidateFunction>();
for (const [def, kinds] of [
  ['vpcNode', ['vpc']],
  ['subnetNode', ['subnet']],
  ['pendingContractNode', pendingKinds()],
] as const) {
  const branch = ajv.getSchema(`${IR_SCHEMA_ID}#/$defs/${def}`);
  if (!branch) throw new Error(`Schema is missing the ${def} definition.`);
  for (const kind of kinds) BRANCH_BY_KIND.set(kind, branch);
}

function pendingKinds(): string[] {
  return [...schemaJson.$defs.pendingContractKind.enum];
}

/** Every kind the schema knows, whether or not its parameters are typed yet. */
export function resourceKinds(): ResourceKind[] {
  return [...schemaJson.$defs.resourceKind.enum] as ResourceKind[];
}

/** Kinds whose parameters are still an untyped bag, awaiting a resource contract. */
export function pendingContractKinds(): PendingContractKind[] {
  return pendingKinds() as PendingContractKind[];
}

/**
 * Kinds whose parameters this schema version types, read off the node branches
 * rather than listed. Typing a kind is a schema edit in three places - the
 * branch, the `oneOf`, the pending enum - and a list here would be a fourth
 * that nobody remembers until a resource silently prices as an untyped bag.
 */
export function typedContractKinds(): ResourceKind[] {
  const defs = schemaJson.$defs as Record<string, { properties?: { kind?: { const?: string } } }>;
  const kinds: ResourceKind[] = [];

  for (const branch of schemaJson.properties.nodes.items.oneOf) {
    const name = branch.$ref.replace('#/$defs/', '');
    const constant = defs[name]?.properties?.kind?.const;
    if (constant !== undefined) kinds.push(constant as ResourceKind);
  }
  return kinds;
}

function toProblem(error: ErrorObject, prefix = ''): IrProblem {
  const property =
    error.keyword === 'additionalProperties' || error.keyword === 'unevaluatedProperties'
      ? `/${String(error.params.additionalProperty ?? error.params.unevaluatedProperty)}`
      : '';
  return {
    pointer: `${prefix}${error.instancePath}${property}` || '',
    message: error.message ?? 'is invalid',
    source: 'schema',
  };
}

function nodeIndexOf(instancePath: string): number | null {
  const match = /^\/nodes\/(\d+)(?:\/|$)/.exec(instancePath);
  return match ? Number(match[1]) : null;
}

function schemaProblems(input: unknown): IrProblem[] {
  if (validateDocument(input)) return [];

  const errors = validateDocument.errors ?? [];
  const nodes = (input as { nodes?: unknown }).nodes;
  const ambiguous = new Set(
    errors
      .filter((error) => error.keyword === 'oneOf')
      .map((error) => nodeIndexOf(error.instancePath))
      .filter((index): index is number => index !== null)
  );

  const problems: IrProblem[] = [];
  for (const error of errors) {
    const index = nodeIndexOf(error.instancePath);
    if (index !== null && ambiguous.has(index)) continue;
    problems.push(toProblem(error));
  }

  for (const index of [...ambiguous].sort((a, b) => a - b)) {
    const node = Array.isArray(nodes) ? nodes[index] : undefined;
    const kind = (node as { kind?: unknown } | undefined)?.kind;
    const branch = typeof kind === 'string' ? BRANCH_BY_KIND.get(kind) : undefined;
    if (!branch) {
      problems.push({
        pointer: `/nodes/${index}/kind`,
        message: `${JSON.stringify(kind)} is not a resource kind this schema version knows`,
        source: 'schema',
      });
      continue;
    }
    if (branch(node)) continue;
    for (const error of branch.errors ?? []) {
      problems.push(toProblem(error, `/nodes/${index}`));
    }
  }

  return problems;
}

/**
 * The rules JSON Schema cannot express. They live here rather than in each
 * consumer because a document that passes the schema and fails these is exactly
 * the document that produces infrastructure code referencing a resource that
 * was never declared.
 */
function referenceProblems(document: ArchitectureIr): IrProblem[] {
  const problems: IrProblem[] = [];
  const byId = new Map<string, IrNode>();

  document.nodes.forEach((node, index) => {
    if (byId.has(node.id)) {
      problems.push({
        pointer: `/nodes/${index}/id`,
        message: `duplicates the id of an earlier node (${node.id})`,
        source: 'reference',
      });
      return;
    }
    byId.set(node.id, node);
  });

  const seenEdgeIds = new Set<string>();
  document.edges.forEach((edge, index) => {
    if (seenEdgeIds.has(edge.id)) {
      problems.push({
        pointer: `/edges/${index}/id`,
        message: `duplicates the id of an earlier edge (${edge.id})`,
        source: 'reference',
      });
    }
    seenEdgeIds.add(edge.id);

    for (const end of ['source', 'target'] as const) {
      if (!byId.has(edge[end])) {
        problems.push({
          pointer: `/edges/${index}/${end}`,
          message: `names ${edge[end]}, which no node declares`,
          source: 'reference',
        });
      }
    }
  });

  document.nodes.forEach((node, index) => {
    if (node.parent === undefined || node.parent === null) return;

    const parent = byId.get(node.parent);
    if (!parent) {
      problems.push({
        pointer: `/nodes/${index}/parent`,
        message: `names ${node.parent}, which no node declares`,
        source: 'reference',
      });
      return;
    }

    if (node.kind === 'subnet' && parent.kind !== 'vpc') {
      problems.push({
        pointer: `/nodes/${index}/parent`,
        message: `a subnet must sit in a vpc, but ${parent.id} is a ${parent.kind}`,
        source: 'reference',
      });
    }

    // Walking rather than recursing: a cycle in user input must not be able to
    // exhaust the stack, and the bound is the node count by construction.
    const seen = new Set<string>([node.id]);
    let ancestor: IrNode | undefined = parent;
    while (ancestor) {
      if (seen.has(ancestor.id)) {
        problems.push({
          pointer: `/nodes/${index}/parent`,
          message: `is part of a containment cycle through ${ancestor.id}`,
          source: 'reference',
        });
        break;
      }
      seen.add(ancestor.id);
      ancestor = ancestor.parent ? byId.get(ancestor.parent) : undefined;
    }
  });

  return problems;
}

/** Validates shape, then node references. Never throws for malformed input. */
export function validateIr(input: unknown): IrValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      valid: false,
      problems: [{ pointer: '', message: 'is not a JSON object', source: 'schema' }],
    };
  }

  const problems = schemaProblems(input);
  if (problems.length > 0) return { valid: false, problems };

  const document = input as ArchitectureIr;
  const references = referenceProblems(document);
  if (references.length > 0) return { valid: false, problems: references };

  return { valid: true, document };
}

/** Throws `IrValidationError` with the same problems attached. For call sites that cannot branch. */
export function assertValidIr(input: unknown): ArchitectureIr {
  const result = validateIr(input);
  if (!result.valid) throw new IrValidationError(result.problems);
  return result.document;
}
