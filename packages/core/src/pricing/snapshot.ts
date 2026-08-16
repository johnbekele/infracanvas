/**
 * Reader for the committed AWS Price List snapshot.
 *
 * Cost has to be reproducible: the same architecture priced twice must give the
 * same number, and that number must be testable. So prices come from a file in
 * the repository rather than from the Price List Query API, which needs
 * credentials this product does not ask for and can answer differently between
 * two calls.
 *
 * Node only. The payload is around 2 MB gzipped, which would fail the Gate 6
 * bundle budget on its own, so this module is exported from `@infracanvas/core/pricing`
 * rather than the package root and must never be imported from `apps/web`.
 * Cost figures reach the browser through the API.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const PRICE_SNAPSHOT_VERSION = 1;

export type PriceUnit =
  | 'Hrs'
  | 'GB-Mo'
  | 'GB'
  | 'Requests'
  | 'IOPS-Mo'
  | 'ACU-Hr'
  | 'LCU-Hrs'
  | 'vCPU-Hours';

export interface PriceRate {
  /** Matches `AWSService['id']` in the catalog, not the AWS offer code. */
  serviceId: string;
  region: string;
  /** The AWS SKU, kept so a figure can be traced back to the source offer. */
  sku: string;
  usageType: string;
  unit: PriceUnit;
  usd: number;
  /** Whitelisted attributes only: instanceType, databaseEngine, storageClass,
   *  deploymentOption, cacheEngine, memory, vcpu. */
  attributes: Record<string, string>;
}

export interface PriceSnapshot {
  version: typeof PRICE_SNAPSHOT_VERSION;
  currency: 'USD';
  regions: string[];
  /** One entry per source offer file, sorted by offer code. */
  sources: { offerCode: string; publicationDate: string; version: string }[];
  /** Sorted by serviceId, region, sku, so the encoding is stable. */
  rates: PriceRate[];
}

const PAYLOAD_PATH = join('data', 'pricing', 'aws-prices.v1.json.gz');

/**
 * Loading and inflating 2 MB is not free, and a cost estimate touches the
 * snapshot once per node. One read per path per process is enough.
 */
const loaded = new Map<string, PriceSnapshot>();

/** Lookup buckets, built on first use and discarded with the snapshot. */
const indexed = new WeakMap<PriceSnapshot, Map<string, PriceRate[]>>();

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function assertSnapshot(value: unknown, source: string): PriceSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${source} does not contain a price snapshot.`);
  }
  const candidate = value as Partial<PriceSnapshot>;

  if (candidate.version !== PRICE_SNAPSHOT_VERSION) {
    throw new Error(
      `${source} is snapshot version ${String(candidate.version)}, but this loader reads ` +
        `version ${PRICE_SNAPSHOT_VERSION}. Rebuild the snapshot or upgrade the reader.`
    );
  }
  if (candidate.currency !== 'USD') {
    throw new Error(`${source} is priced in ${String(candidate.currency)}, not USD.`);
  }
  if (!Array.isArray(candidate.regions) || !Array.isArray(candidate.sources)) {
    throw new Error(`${source} is missing its region or source list.`);
  }
  if (!Array.isArray(candidate.rates)) {
    throw new Error(`${source} is missing its rates.`);
  }
  for (const rate of candidate.rates) {
    if (
      typeof rate?.serviceId !== 'string' ||
      typeof rate.region !== 'string' ||
      typeof rate.sku !== 'string' ||
      typeof rate.usageType !== 'string' ||
      typeof rate.unit !== 'string' ||
      typeof rate.usd !== 'number' ||
      !isRecordOfStrings(rate.attributes)
    ) {
      throw new Error(`${source} contains a malformed rate: ${JSON.stringify(rate)}`);
    }
  }
  return candidate as PriceSnapshot;
}

/**
 * Walk up from a starting directory looking for the committed payload.
 *
 * Both the repository checkout and an installed copy under `node_modules` are
 * searched, because the same build output serves the API running from source
 * and the API running from a published package.
 */
function findPayload(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();

  for (const start of [here, process.cwd()]) {
    let directory = resolve(start);
    for (;;) {
      if (!seen.has(directory)) {
        seen.add(directory);
        const candidate = join(directory, PAYLOAD_PATH);
        try {
          readFileSync(candidate);
          return candidate;
        } catch {
          // Keep walking; the payload lives at the repository root.
        }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  throw new Error(
    `Could not find ${PAYLOAD_PATH} above ${here} or ${process.cwd()}. ` +
      'Run `node scripts/ci/build-price-snapshot.mjs` to build it.'
  );
}

/** Reads and inflates the committed snapshot. Node only; never import from web code. */
export function loadPriceSnapshot(path?: string): PriceSnapshot {
  const file = path === undefined ? findPayload() : isAbsolute(path) ? path : resolve(path);

  const cached = loaded.get(file);
  if (cached !== undefined) return cached;

  const snapshot = assertSnapshot(
    JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')),
    file
  );
  loaded.set(file, snapshot);
  return snapshot;
}

function bucketsOf(snapshot: PriceSnapshot): Map<string, PriceRate[]> {
  const existing = indexed.get(snapshot);
  if (existing !== undefined) return existing;

  const buckets = new Map<string, PriceRate[]>();
  for (const rate of snapshot.rates) {
    const key = `${rate.serviceId}\u0000${rate.region}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [rate]);
    else bucket.push(rate);
  }
  indexed.set(snapshot, buckets);
  return buckets;
}

/**
 * Exact lookup. Returns null rather than the nearest match, because a wrong
 * price that looks right is worse than a missing one.
 *
 * A query must identify exactly one rate. Matching several is a missing
 * discriminator rather than a result, so it returns null for the same reason
 * matching none does: the caller asked a question this snapshot cannot answer.
 *
 * That rule is what makes the promise above true. Attribute matching is
 * `every`, and `every` over an empty set is true, so a query naming no
 * attributes used to match the whole bucket and return its first entry. Most
 * services do not discriminate on attributes at all -- every Lambda, ALB and
 * Fargate rate in the snapshot carries no attributes and is told apart by
 * `usageType` -- so pricing a Lambda function the obvious way returned the
 * first Lambda rate by SKU, which is an EC2 management hour.
 */
export function findRate(
  snapshot: PriceSnapshot,
  query: {
    serviceId: string;
    region: string;
    attributes: Record<string, string>;
    /** The discriminator for services whose rates share their attributes. */
    usageType?: string;
  }
): PriceRate | null {
  const bucket = bucketsOf(snapshot).get(`${query.serviceId}\u0000${query.region}`);
  if (bucket === undefined) return null;

  const wanted = Object.entries(query.attributes);
  const matches = bucket.filter(
    (rate) =>
      (query.usageType === undefined || rate.usageType === query.usageType) &&
      wanted.every(([name, value]) => rate.attributes[name] === value)
  );

  const [only] = matches;
  return matches.length === 1 && only !== undefined ? only : null;
}
