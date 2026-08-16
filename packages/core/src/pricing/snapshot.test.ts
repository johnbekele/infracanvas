import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

import { PRICE_SNAPSHOT_VERSION, findRate, loadPriceSnapshot } from './snapshot';

/**
 * The build script is plain Node tooling with no type declarations, so it is
 * pulled in by URL rather than by module specifier. The two behaviours tested
 * through it -- the size ceiling and the refusal to accept a half-read offer
 * file -- are the ones that keep a bad artefact out of the repository, and
 * neither needs the network.
 */
const buildScript = await import(
  new URL('../../../../scripts/ci/build-price-snapshot.mjs', import.meta.url).href
);

const scratch = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes a gzipped payload the loader will accept or reject on its own terms. */
function payloadFile(name: string, body: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(body), 'utf8')));
  return path;
}

const OFFER = { offerCode: 'TestOffer', slices: [{ serviceId: 's3' }] };

const OFFER_FILE = JSON.stringify({
  formatVersion: 'v1.0',
  offerCode: 'TestOffer',
  version: '20260101000000',
  publicationDate: '2026-01-01T00:00:00Z',
  products: {
    ABCD1234: {
      sku: 'ABCD1234',
      productFamily: 'Storage',
      attributes: {
        regionCode: 'us-east-1',
        storageClass: 'General Purpose',
        usagetype: 'TimedStorage-ByteHrs',
      },
    },
  },
  terms: {
    OnDemand: {
      ABCD1234: {
        'ABCD1234.JRTCKXETXF': {
          offerTermCode: 'JRTCKXETXF',
          priceDimensions: {
            'ABCD1234.JRTCKXETXF.6YS6EN2CT7': {
              unit: 'GB-Mo',
              beginRange: '0',
              pricePerUnit: { USD: '0.0230000000' },
            },
          },
        },
      },
    },
  },
});

describe('loadPriceSnapshot', () => {
  it('loads and inflates the committed snapshot', () => {
    const started = performance.now();
    const snapshot = loadPriceSnapshot();
    const cold = performance.now() - started;

    expect(snapshot.version).toBe(PRICE_SNAPSHOT_VERSION);
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.regions).toContain('us-east-1');
    expect(snapshot.rates.length).toBeGreaterThan(1000);
    expect(snapshot.sources.length).toBeGreaterThan(0);

    // Every rate must be traceable back to a SKU in a source offer file.
    expect(snapshot.rates.every((rate) => /^[A-Z0-9.]{8,}$/.test(rate.sku))).toBe(true);

    // Reserved, Spot and Savings Plan terms describe commitments this product
    // does not model, and the build reads only `terms.OnDemand`. These are the
    // usage types those terms bill under, and none of them survive.
    // (`Cluster:ml.*-Reserved` does, and should: SageMaker sells reserved
    // capacity on an on-demand term.)
    expect(
      snapshot.rates.some((rate) =>
        /HeavyUsage|SpotUsage|UnusedBox|SavingsPlan/.test(rate.usageType)
      )
    ).toBe(false);

    expect(cold).toBeLessThan(150);
    // Memoised for the process: a second call is the same object, not a reread.
    expect(loadPriceSnapshot()).toBe(snapshot);
  });

  it('rejects a snapshot whose version does not match the loader', () => {
    const path = payloadFile('wrong-version.json.gz', {
      version: PRICE_SNAPSHOT_VERSION + 1,
      currency: 'USD',
      regions: ['us-east-1'],
      sources: [],
      rates: [],
    });

    expect(() => loadPriceSnapshot(path)).toThrow(/snapshot version 2/);
  });

  it('keeps rates sorted so the encoding is stable', () => {
    const snapshot = loadPriceSnapshot();
    const key = (index: number) => {
      const rate = snapshot.rates[index];
      return `${rate.serviceId}\u0000${rate.region}\u0000${rate.sku}`;
    };

    for (let i = 1; i < snapshot.rates.length; i += 1) {
      expect(key(i - 1) < key(i)).toBe(true);
    }
  });
});

describe('findRate', () => {
  const snapshot = loadPriceSnapshot();

  it('finds an exact rate by service, region, and attributes', () => {
    const rate = findRate(snapshot, {
      serviceId: 'ec2',
      region: 'us-east-1',
      attributes: { instanceType: 'm5.large' },
    });

    expect(rate).not.toBeNull();
    expect(rate?.serviceId).toBe('ec2');
    expect(rate?.region).toBe('us-east-1');
    expect(rate?.unit).toBe('Hrs');
    expect(rate?.attributes.instanceType).toBe('m5.large');
    expect(rate?.usd).toBeGreaterThan(0);
  });

  it('returns null for a region that is not in the snapshot', () => {
    // ap-southeast-2 is a real region the snapshot deliberately omits. It has
    // to read as unpriced, never as us-east-1 wearing another name.
    expect(snapshot.regions).not.toContain('ap-southeast-2');
    expect(
      findRate(snapshot, {
        serviceId: 'ec2',
        region: 'ap-southeast-2',
        attributes: { instanceType: 'm5.large' },
      })
    ).toBeNull();
  });

  it('returns null rather than a near match for an unknown instance type', () => {
    expect(
      findRate(snapshot, {
        serviceId: 'ec2',
        region: 'us-east-1',
        attributes: { instanceType: 'm5.enormous' },
      })
    ).toBeNull();
  });

  /**
   * The regression this lookup exists to prevent. Every Lambda rate in the
   * snapshot carries no attributes, so an attribute-only query matches all 494
   * of them. Answering with the first by SKU prices a function at an EC2
   * management hour -- a figure that is wrong by four orders of magnitude and
   * looks entirely plausible on a cost panel.
   */
  it('returns null when the query names nothing that tells the rates apart', () => {
    const undiscriminated = snapshot.rates.filter(
      (rate) => rate.serviceId === 'lambda' && rate.region === 'us-east-1'
    );
    expect(undiscriminated.length).toBeGreaterThan(1);
    expect(undiscriminated.every((rate) => Object.keys(rate.attributes).length === 0)).toBe(true);

    expect(
      findRate(snapshot, { serviceId: 'lambda', region: 'us-east-1', attributes: {} })
    ).toBeNull();
  });

  it('finds a rate by usage type where the attributes do not discriminate', () => {
    const rate = findRate(snapshot, {
      serviceId: 'lambda',
      region: 'us-east-1',
      attributes: {},
      usageType: 'Request',
    });

    expect(rate).not.toBeNull();
    expect(rate?.usageType).toBe('Request');
    expect(rate?.unit).toBe('Requests');
    // $0.20 per million requests, which is the published figure.
    expect(rate?.usd).toBeCloseTo(0.0000002, 12);
  });

  it('returns null when a usage type names no rate', () => {
    expect(
      findRate(snapshot, {
        serviceId: 'lambda',
        region: 'us-east-1',
        attributes: {},
        usageType: 'Request-NoSuchArchitecture',
      })
    ).toBeNull();
  });
});

describe('build', () => {
  it('fails the size check when the payload grows past the limit', () => {
    const withinBudget = Buffer.alloc(1024);
    expect(() => buildScript.enforceBudget(withinBudget, withinBudget)).not.toThrow();

    expect(() =>
      buildScript.enforceBudget(withinBudget, Buffer.alloc(buildScript.MAX_GZIP_BYTES + 1))
    ).toThrow(/over budget/);

    expect(() =>
      buildScript.enforceBudget(Buffer.alloc(buildScript.MAX_INFLATED_BYTES + 1), withinBudget)
    ).toThrow(/over budget/);
  });

  it('parses a truncated offer file as an error rather than a partial snapshot', async () => {
    const whole = join(scratch, 'offer.json');
    writeFileSync(whole, OFFER_FILE);
    const { rates } = await buildScript.extract(whole, OFFER, 'us-east-1');
    expect(rates).toHaveLength(1);
    expect(rates[0].usd).toBe(0.023);

    const truncated = join(scratch, 'offer-truncated.json');
    writeFileSync(truncated, OFFER_FILE.slice(0, Math.floor(OFFER_FILE.length * 0.6)));

    await expect(buildScript.extract(truncated, OFFER, 'us-east-1')).rejects.toThrow();
  });
});
