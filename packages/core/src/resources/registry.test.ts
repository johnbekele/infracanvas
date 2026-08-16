import { pendingContractKinds, resourceKinds } from '@infracanvas/ir-schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_USAGE, type ResourceContract } from './contract';
import { rdsInstanceContract } from './rds-instance';
import {
  getResourceContract,
  kindsWithoutContract,
  listResourceContracts,
  registerResource,
  resetResourceRegistry,
} from './registry';
import { registerBuiltInResources } from './index';

// Registration is global, so each test starts from the built-in set rather than
// from whatever the test before it happened to leave behind.
beforeEach(() => {
  resetResourceRegistry();
  registerBuiltInResources();
});

describe('the registry', () => {
  it('refuses to register the same resource kind twice', () => {
    expect(() => registerResource(rdsInstanceContract)).toThrow(/already registered/);
  });

  it('reports every kind without a contract, matching the schema pending list', () => {
    // The schema's pending enum and the registry are two statements of the same
    // fact, and this keeps them from drifting: a kind whose parameters become
    // typed without gaining a contract has to be named here.
    const withoutContract = new Set(kindsWithoutContract());

    for (const pending of pendingContractKinds()) {
      expect(withoutContract, pending).toContain(pending);
    }

    // The issue expects these two sets to be equal. They are not yet, because
    // `vpc` and `subnet` were typed by the schema before contracts existed, and
    // listing them is more honest than relaxing the assertion: this fails the
    // day either gains a contract, or a third kind joins them.
    const typedButUncontracted = [...withoutContract].filter(
      (kind) => !new Set<string>(pendingContractKinds()).has(kind)
    );
    expect(typedButUncontracted.sort()).toEqual(['subnet', 'vpc']);
  });

  it('finds a registered contract and returns undefined for one that has none', () => {
    expect(getResourceContract('rds_instance')).toBe(rdsInstanceContract);
    expect(getResourceContract('s3_bucket')).toBeUndefined();
  });

  it('lists contracts in a stable order rather than registration order', () => {
    const kinds = listResourceContracts().map((contract) => contract.kind);
    expect(kinds).toEqual([...kinds].sort());
  });

  it('registers every contract against a kind the schema declares', () => {
    const known = new Set<string>(resourceKinds());
    for (const contract of listResourceContracts()) {
      expect(known, contract.kind).toContain(contract.kind);
    }
  });

  it('holds all seven answers for every registered resource', () => {
    // A resource missing its latency model cannot be registered, rather than
    // being registered and silently contributing zero to every estimate.
    for (const contract of listResourceContracts() as ResourceContract<'rds_instance'>[]) {
      expect(typeof contract.cost, contract.kind).toBe('function');
      expect(typeof contract.latency, contract.kind).toBe('function');
      expect(typeof contract.reliability, contract.kind).toBe('function');
      expect(typeof contract.emitPulumi, contract.kind).toBe('function');
      expect(contract.rules.length, contract.kind).toBeGreaterThan(0);
      expect(contract.paramsDef, contract.kind).toMatch(/Params$/);
    }
  });
});

describe('performance', () => {
  it('evaluates cost, latency, reliability and rules for a 200 node document in under 50ms', () => {
    const params = {
      engine: 'postgres',
      instanceClass: 'db.t3.micro',
      allocatedStorageGb: 20,
      multiAz: false,
      publiclyAccessible: false,
      deletionProtection: false,
    } as const;
    const context = { ancestors: [], region: 'us-east-1' };

    const evaluateAll = (): void => {
      for (let node = 0; node < 200; node += 1) {
        const contract = getResourceContract('rds_instance')!;
        contract.cost(params, DEFAULT_USAGE);
        contract.latency(params);
        contract.reliability(params);
        for (const rule of contract.rules) rule.evaluate(params, context);
      }
    };

    for (let warmUp = 0; warmUp < 3; warmUp += 1) evaluateAll();

    const samples: number[] = [];
    for (let sample = 0; sample < 11; sample += 1) {
      const started = performance.now();
      evaluateAll();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);

    expect(samples[5]).toBeLessThan(50);
  });
});
