import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import schemaJson from '../schema/architecture-ir.schema.json';
import type { ArchitectureIr } from './generated/types.js';
import {
  assertValidIr,
  IrValidationError,
  pendingContractKinds,
  resourceKinds,
  validateIr,
} from './validate.js';

const FIXTURES = join(__dirname, '..', 'fixtures');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

function validFixtureNames(): string[] {
  return readdirSync(FIXTURES).filter((entry) => entry.endsWith('.json'));
}

function invalidFixtureNames(): string[] {
  return readdirSync(join(FIXTURES, 'invalid')).map((entry) => join('invalid', entry));
}

/** The three-tier fixture with one edit, so a test states only what it changes. */
function threeTierWith(edit: (document: ArchitectureIr) => void): ArchitectureIr {
  const document = fixture('three-tier.json') as ArchitectureIr;
  edit(document);
  return document;
}

describe('validateIr', () => {
  it('accepts every valid fixture', () => {
    for (const name of validFixtureNames()) {
      const result = validateIr(fixture(name));
      expect(result.valid, `${name}: ${JSON.stringify(!result.valid && result.problems)}`).toBe(
        true
      );
    }
  });

  it('rejects every invalid fixture with a pointer', () => {
    for (const name of invalidFixtureNames()) {
      const result = validateIr(fixture(name));
      expect(result.valid, name).toBe(false);
      if (result.valid) continue;
      expect(result.problems.length, name).toBeGreaterThan(0);
      for (const problem of result.problems) {
        expect(problem.pointer, name).toMatch(/^\/(nodes|edges)\//);
      }
    }
  });

  it('rejects a document with an edge pointing at a missing node', () => {
    const result = validateIr(
      threeTierWith((document) => {
        document.edges[0].target = 'ecs-worker';
      })
    );

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems).toContainEqual({
      pointer: '/edges/0/target',
      message: 'names ecs-worker, which no node declares',
      source: 'reference',
    });
  });

  it('rejects a parent cycle rather than recursing until the stack overflows', () => {
    const result = validateIr(fixture('invalid/parent-cycle.json'));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems.every((problem) => problem.source === 'reference')).toBe(true);
    expect(result.problems.some((problem) => problem.message.includes('containment cycle'))).toBe(
      true
    );
  });

  it('rejects a vpc parameter that the schema does not declare', () => {
    const result = validateIr(fixture('invalid/extra-vpc-param.json'));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ pointer: '/nodes/0/params/instanceTenancy', source: 'schema' })
    );
  });

  it('rejects a node that declares no parameters at all', () => {
    const result = validateIr(
      threeTierWith((document) => {
        delete (document.nodes[0] as Partial<(typeof document.nodes)[0]>).params;
      })
    );

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ pointer: '/nodes/0', source: 'schema' })
    );
  });

  it('rejects a subnet whose parent is not a vpc', () => {
    const result = validateIr(
      threeTierWith((document) => {
        document.nodes[2].parent = 'subnet-public-a';
      })
    );

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems).toContainEqual({
      pointer: '/nodes/2/parent',
      message: 'a subnet must sit in a vpc, but subnet-public-a is a subnet',
      source: 'reference',
    });
  });

  it('rejects a cidr block that is not valid ipv4 notation', () => {
    for (const cidr of ['10.0.0/16', '10.0.0.0', '10.0.0.0/33', '256.0.0.0/8', '10.0.0.0/016']) {
      const result = validateIr(
        threeTierWith((document) => {
          document.nodes[0].params.cidrBlock = cidr;
        })
      );
      expect(result.valid, cidr).toBe(false);
      if (result.valid) continue;
      expect(result.problems[0].pointer, cidr).toBe('/nodes/0/params/cidrBlock');
    }
  });

  it('reports duplicate node ids rather than silently keeping the last one', () => {
    const result = validateIr(fixture('invalid/duplicate-node-id.json'));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems).toContainEqual({
      pointer: '/nodes/1/id',
      message: 'duplicates the id of an earlier node (vpc-main)',
      source: 'reference',
    });
  });

  it('returns problems rather than throwing when given a non-object', () => {
    for (const input of [undefined, null, '{}', 42, [], true]) {
      const result = validateIr(input);
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.problems[0].message).toBe('is not a JSON object');
    }
  });

  it('names the kind when a node declares one the schema does not know', () => {
    const result = validateIr(
      threeTierWith((document) => {
        (document.nodes[3] as { kind: string }).kind = 'quantum_gateway';
      })
    );

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({ pointer: '/nodes/3/kind', source: 'schema' })
    );
  });
});

describe('assertValidIr', () => {
  it('returns the document when it is valid', () => {
    expect(assertValidIr(fixture('minimal.json')).name).toBe('Minimal');
  });

  it('throws with the problems attached when it is not', () => {
    try {
      assertValidIr(fixture('invalid/unknown-parent.json'));
      expect.unreachable('expected assertValidIr to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IrValidationError);
      expect((error as IrValidationError).problems[0].source).toBe('reference');
    }
  });
});

describe('resource kind coverage', () => {
  it('reports every resource kind as either contracted or pending exactly once', () => {
    const typed = [
      schemaJson.$defs.vpcNode.properties.kind.const,
      schemaJson.$defs.subnetNode.properties.kind.const,
    ] as string[];
    const pending = pendingContractKinds();

    for (const kind of resourceKinds()) {
      const appearances =
        typed.filter((k) => k === kind).length + pending.filter((k) => k === kind).length;
      expect(appearances, kind).toBe(1);
    }
    expect(typed.length + pending.length).toBe(resourceKinds().length);
  });
});

describe('performance', () => {
  it('validates a 500 node document in under 10ms', () => {
    const document: ArchitectureIr = {
      irVersion: '1.0.0',
      name: 'Wide',
      provider: 'aws',
      region: 'eu-west-1',
      nodes: [{ id: 'vpc-main', kind: 'vpc', name: 'Main', params: { cidrBlock: '10.0.0.0/16' } }],
      edges: [],
    };
    for (let index = 0; index < 499; index += 1) {
      document.nodes.push({
        id: `svc-${index}`,
        kind: 'lambda_function',
        name: `Function ${index}`,
        parent: 'vpc-main',
        params: { memoryMb: 512 },
      });
      if (index > 0) {
        document.edges.push({
          id: `edge-${index}`,
          kind: 'connects',
          source: `svc-${index - 1}`,
          target: `svc-${index}`,
        });
      }
    }

    // Warm the compiled validator so the measurement is of validation rather
    // than of the first calls' lazy work.
    for (let run = 0; run < 5; run += 1) {
      expect(validateIr(document).valid).toBe(true);
    }

    // The median over repeats rather than a single reading: a shared CI runner
    // will occasionally deschedule any one call, and a budget that fails for
    // that reason teaches everyone to rerun red checks.
    const samples: number[] = [];
    for (let run = 0; run < 21; run += 1) {
      const started = performance.now();
      validateIr(document);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(10);
  });
});
