#!/usr/bin/env node
/**
 * Build the committed AWS Price List snapshot.
 *
 * The bulk offer files are far too large to parse or to commit -- the EC2 file
 * for a single region is around 450 MB of JSON -- so this script streams each
 * one through an incremental parser and keeps a deliberately small slice of it:
 * on-demand USD rates, for the services the canvas can place, in four regions,
 * on current-generation hardware, carrying a fixed set of product attributes.
 *
 * The output carries no wall-clock time and every object key is sorted, so a
 * scheduled rebuild that finds unchanged prices writes a byte-identical file
 * and opens no pull request.
 *
 *   node scripts/ci/build-price-snapshot.mjs            rebuild in place
 *   node scripts/ci/build-price-snapshot.mjs --check    rebuild elsewhere and diff
 *   node scripts/ci/build-price-snapshot.mjs --cache-dir .cache/pricing
 *   node scripts/ci/build-price-snapshot.mjs --offer AmazonS3
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import parser from 'stream-json/parser.js';
import pick from 'stream-json/filters/pick.js';
import streamObject from 'stream-json/streamers/stream-object.js';
import streamValues from 'stream-json/streamers/stream-values.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = join(REPO_ROOT, 'data/pricing');
const PAYLOAD_NAME = 'aws-prices.v1.json.gz';
const MANIFEST_NAME = 'MANIFEST.json';

const SNAPSHOT_VERSION = 1;
const PRICING_HOST = 'https://pricing.us-east-1.amazonaws.com';
const OFFER_INDEX = `${PRICING_HOST}/offers/v1.0/aws/index.json`;

/**
 * The regions the canvas offers by default. Anything else is an explicit gap:
 * substituting a neighbouring region's rate would produce a plausible number
 * that is simply wrong.
 *
 * These are data, not configuration -- widening the list changes the artefact
 * and its size budget, so it belongs in the build rather than in an env var.
 */
const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1'];

/** Hard ceilings, enforced here so the artefact cannot quietly outgrow the repository. */
export const MAX_GZIP_BYTES = 2 * 1024 * 1024;
export const MAX_INFLATED_BYTES = 12 * 1024 * 1024;

/**
 * Region files are fetched and parsed this many at a time. The unit of work is
 * one region of one offer rather than a whole offer: EC2 is four fifths of the
 * input and taking its four regions one after another would leave the build
 * waiting on a single connection for an hour.
 */
const CONCURRENCY = 6;

/**
 * The snapshot's unit vocabulary. AWS spells the same unit several ways across
 * offers -- `Hrs`, `Hours` and `hours` all mean an hour -- so each raw unit is
 * canonicalised here. A rate whose unit has no canonical form is dropped rather
 * than guessed at: `GB-Hours` is not `GB-Mo`, and pretending otherwise would be
 * a 730x error.
 */
const UNITS = new Map([
  ['hrs', 'Hrs'],
  ['hr', 'Hrs'],
  ['hour', 'Hrs'],
  ['hours', 'Hrs'],
  ['gb-mo', 'GB-Mo'],
  ['gb-month', 'GB-Mo'],
  ['gb-months', 'GB-Mo'],
  ['gb', 'GB'],
  ['gigabytes', 'GB'],
  ['requests', 'Requests'],
  ['request', 'Requests'],
  ['api requests', 'Requests'],
  ['iops-mo', 'IOPS-Mo'],
  ['acu-hr', 'ACU-Hr'],
  ['acu-hrs', 'ACU-Hr'],
  ['lcu-hrs', 'LCU-Hrs'],
  ['lcu-hr', 'LCU-Hrs'],
  ['vcpu-hours', 'vCPU-Hours'],
  ['vcpu-hrs', 'vCPU-Hours'],
]);

/**
 * The only product attributes that reach the payload. The whole `attributes`
 * object is where most of the bytes are, and most of it -- network performance,
 * normalisation size factors, marketing descriptions -- prices nothing.
 *
 * `storageClass` reads from `volumeApiName` for EBS, which spells the same idea
 * differently: `gp3` is the storage class a user picks in the canvas.
 */
const ATTRIBUTES = {
  instanceType: (a) => a.instanceType,
  databaseEngine: (a) => a.databaseEngine,
  storageClass: (a) => a.storageClass ?? a.volumeApiName,
  deploymentOption: (a) => a.deploymentOption,
  cacheEngine: (a) => a.cacheEngine,
  memory: (a) => a.memory,
  vcpu: (a) => a.vcpu,
};

/**
 * Extended support is a surcharge for staying on an engine version past its end
 * of life, metered per hour against the same instance type as the node itself.
 * It is on-demand, so it survives every other filter, and it sorts ahead of the
 * node rate for the same attributes -- which would hand a caller asking for a
 * `cache.t3.micro` a deprecation fee instead of a price.
 */
const EXTENDED_SUPPORT = /extendedsupport/i;

/** Engines the canvas can select, which is the only pricing that can be reached. */
const RDS_ENGINES = new Set(['PostgreSQL', 'MySQL', 'MariaDB']);
const AURORA_ENGINES = new Set(['Aurora PostgreSQL', 'Aurora MySQL']);
const CACHE_ENGINES = new Set(['Redis', 'Memcached']);

/**
 * Which offer files to read, and how each maps onto the catalog in
 * `packages/core/src/aws-services.ts`.
 *
 * A slice narrows an offer to one catalog service. `families` restricts it to
 * named product families; `require` demands exact attribute values. Both exist
 * for the same reason: the attribute whitelist has to be a key. EC2 prices the
 * same instance type under six operating systems and three tenancies, and
 * without a selector the payload would carry six rates that look identical and
 * disagree about the price.
 */
const OFFERS = [
  {
    offerCode: 'AmazonEC2',
    slices: [
      {
        serviceId: 'ec2',
        families: ['Compute Instance'],
        require: {
          operatingSystem: 'Linux',
          tenancy: 'Shared',
          preInstalledSw: 'NA',
          capacitystatus: 'Used',
          licenseModel: 'No License required',
        },
      },
      { serviceId: 'ec2', families: ['Storage', 'System Operation', 'Provisioned Throughput'] },
      { serviceId: 'nat-gateway', families: ['NAT Gateway'] },
    ],
  },
  {
    offerCode: 'AmazonRDS',
    slices: [
      {
        serviceId: 'rds',
        require: { databaseEngine: RDS_ENGINES, licenseModel: 'No license required' },
      },
      {
        serviceId: 'rds',
        families: ['Database Storage'],
        require: { databaseEngine: RDS_ENGINES },
      },
      { serviceId: 'aurora', require: { databaseEngine: AURORA_ENGINES } },
    ],
  },
  {
    offerCode: 'AmazonElastiCache',
    slices: [{ serviceId: 'elasticache', require: { cacheEngine: CACHE_ENGINES } }],
  },
  {
    offerCode: 'AWSELB',
    slices: [
      { serviceId: 'alb', families: ['Load Balancer-Application'] },
      { serviceId: 'nlb', families: ['Load Balancer-Network'] },
    ],
  },
  {
    // The vector engine is the same managed OpenSearch cluster wearing another
    // name in the catalog, and it bills from the same rates.
    offerCode: 'AmazonES',
    slices: [{ serviceId: 'opensearch', alsoAs: ['opensearch-vector'] }],
  },
  { offerCode: 'AmazonS3', slices: [{ serviceId: 's3' }] },
  { offerCode: 'AWSLambda', slices: [{ serviceId: 'lambda' }] },
  {
    offerCode: 'AmazonECS',
    slices: [
      { serviceId: 'fargate', require: { usagetype: (value) => value.includes('Fargate') } },
      { serviceId: 'ecs' },
    ],
  },
  { offerCode: 'AmazonEKS', slices: [{ serviceId: 'eks-cluster' }] },
  { offerCode: 'AmazonECR', slices: [{ serviceId: 'ecr' }] },
  { offerCode: 'AWSAppRunner', slices: [{ serviceId: 'app-runner' }] },
  { offerCode: 'AWSAmplify', slices: [{ serviceId: 'amplify' }] },
  { offerCode: 'AmazonDynamoDB', slices: [{ serviceId: 'dynamodb' }] },
  { offerCode: 'AmazonMemoryDB', slices: [{ serviceId: 'memorydb' }] },
  { offerCode: 'AmazonDocDB', slices: [{ serviceId: 'documentdb' }] },
  { offerCode: 'AmazonNeptune', slices: [{ serviceId: 'neptune' }] },
  { offerCode: 'AmazonMCS', slices: [{ serviceId: 'keyspaces' }] },
  { offerCode: 'AmazonEFS', slices: [{ serviceId: 'efs' }] },
  { offerCode: 'AmazonRedshift', slices: [{ serviceId: 'redshift' }] },
  { offerCode: 'AmazonAthena', slices: [{ serviceId: 'athena' }] },
  { offerCode: 'AWSGlue', slices: [{ serviceId: 'glue' }] },
  { offerCode: 'AmazonCloudFront', slices: [{ serviceId: 'cloudfront' }] },
  { offerCode: 'AmazonRoute53', slices: [{ serviceId: 'route53' }] },
  {
    offerCode: 'AmazonVPC',
    slices: [{ serviceId: 'vpc-endpoint', families: ['VpcEndpoint'] }, { serviceId: 'vpc' }],
  },
  { offerCode: 'AmazonApiGateway', slices: [{ serviceId: 'api-gateway' }] },
  { offerCode: 'AmazonCognito', slices: [{ serviceId: 'cognito' }] },
  { offerCode: 'AmazonSNS', slices: [{ serviceId: 'sns' }] },
  { offerCode: 'AWSQueueService', slices: [{ serviceId: 'sqs' }] },
  { offerCode: 'AWSEvents', slices: [{ serviceId: 'eventbridge' }] },
  { offerCode: 'AmazonStates', slices: [{ serviceId: 'step-functions' }] },
  { offerCode: 'AmazonKinesis', slices: [{ serviceId: 'kinesis' }] },
  { offerCode: 'AmazonKinesisFirehose', slices: [{ serviceId: 'firehose' }] },
  { offerCode: 'AmazonMSK', slices: [{ serviceId: 'msk' }] },
  { offerCode: 'AmazonMQ', slices: [{ serviceId: 'amazon-mq' }] },
  { offerCode: 'AmazonSES', slices: [{ serviceId: 'ses' }] },
  { offerCode: 'AWSAppSync', slices: [{ serviceId: 'appsync' }] },
  { offerCode: 'AWSSecretsManager', slices: [{ serviceId: 'secrets-manager' }] },
  { offerCode: 'awskms', slices: [{ serviceId: 'kms' }] },
  { offerCode: 'awswaf', slices: [{ serviceId: 'waf' }] },
  { offerCode: 'AWSCertificateManager', slices: [{ serviceId: 'acm' }] },
  { offerCode: 'AmazonCloudWatch', slices: [{ serviceId: 'cloudwatch' }] },
  { offerCode: 'AWSXRay', slices: [{ serviceId: 'x-ray' }] },
  { offerCode: 'AmazonBedrock', slices: [{ serviceId: 'bedrock' }] },
  {
    offerCode: 'AmazonSageMaker',
    slices: [
      { serviceId: 'sagemaker-training', require: { usagetype: (value) => /Train/i.test(value) } },
      { serviceId: 'sagemaker-endpoint' },
    ],
  },
  { offerCode: 'AmazonKendra', slices: [{ serviceId: 'kendra' }] },
  { offerCode: 'AmazonTextract', slices: [{ serviceId: 'textract' }] },
  { offerCode: 'AmazonPolly', slices: [{ serviceId: 'polly' }] },
  { offerCode: 'AmazonRekognition', slices: [{ serviceId: 'rekognition' }] },
  { offerCode: 'comprehend', slices: [{ serviceId: 'comprehend' }] },
  { offerCode: 'transcribe', slices: [{ serviceId: 'transcribe' }] },
  { offerCode: 'translate', slices: [{ serviceId: 'translate' }] },
];

// --- small helpers -----------------------------------------------------------

/** Byte-order comparison, so sorting does not depend on the runner's locale. */
function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort(cmp)) out[key] = sortedKeys(value[key]);
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.json();
}

/**
 * Runs tasks one at a time, in the order they ask.
 *
 * Downloading is bound by the network and parsing by a single core, so the two
 * want different limits. Four EC2 files parsed at once peak at 2.4 GB of
 * resident memory for no gain in wall time -- the parses were already sharing
 * one core -- and the budget for this build is 1 GB.
 */
function createLock() {
  let tail = Promise.resolve();
  return (task) => {
    const started = tail.then(task, task);
    tail = started.then(
      () => undefined,
      () => undefined
    );
    return started;
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        results.push(await worker(next));
      }
    })
  );
  return results;
}

// --- streaming ---------------------------------------------------------------

/**
 * Walk one top-level subtree of an offer file without holding the file in
 * memory. `onEntry` sees one child at a time; returning `false` from `onValue`
 * ends the walk early.
 */
async function walk(path, filter, onEntry) {
  try {
    await pipeline(
      createReadStream(path),
      parser.asStream({ packKeys: true, packStrings: true, packNumbers: true }),
      pick.asStream({ filter }),
      streamObject.asStream(),
      async function (source) {
        for await (const entry of source) onEntry(entry.key, entry.value);
      }
    );
  } catch (error) {
    // A truncated download reaches here. It has to be an error: a half-read
    // offer file would otherwise become a snapshot missing rates nobody asked
    // it to drop.
    throw new Error(`Reading ${filter} from ${path} failed: ${error.message}`, { cause: error });
  }
}

/**
 * Read the header scalars an offer file carries about itself. They precede
 * `products`, so the stream is abandoned as soon as both are in hand and the
 * cost is a few kilobytes rather than another pass over half a gigabyte.
 */
async function readHeader(path) {
  const header = {};
  const source = createReadStream(path);
  try {
    await pipeline(
      source,
      parser.asStream({ packKeys: true, packStrings: true }),
      pick.asStream({ filter: /^(version|publicationDate)$/ }),
      streamValues.asStream(),
      async function (values) {
        for await (const { value } of values) {
          if (header.version === undefined) header.version = value;
          else header.publicationDate = value;
          if (header.version !== undefined && header.publicationDate !== undefined) {
            source.destroy();
            break;
          }
        }
      }
    );
  } catch (error) {
    // Abandoning the pipeline tears the parser down mid-token, which it
    // reports as a parse failure. Anything raised before both scalars arrived
    // is a real problem with the file.
    if (header.version === undefined || header.publicationDate === undefined) {
      throw new Error(`Reading the header of ${path} failed: ${error.message}`, { cause: error });
    }
  }
  if (typeof header.version !== 'string' || typeof header.publicationDate !== 'string') {
    throw new Error(`${path} carries no version or publicationDate`);
  }
  return header;
}

// --- extraction --------------------------------------------------------------

function matches(require, attributes) {
  for (const [name, expected] of Object.entries(require ?? {})) {
    const actual = attributes[name];
    if (typeof expected === 'function') {
      if (!expected(actual ?? '')) return false;
    } else if (expected instanceof Set) {
      if (!expected.has(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function sliceFor(slices, product) {
  for (const slice of slices) {
    if (slice.families && !slice.families.includes(product.productFamily)) continue;
    if (!matches(slice.require, product.attributes ?? {})) continue;
    return slice;
  }
  return null;
}

function whitelisted(attributes) {
  const out = {};
  for (const [name, read] of Object.entries(ATTRIBUTES)) {
    const value = read(attributes);
    if (typeof value === 'string' && value !== '' && value !== 'NA') out[name] = value;
  }
  return out;
}

/**
 * The rate a term describes. Tiered pricing is flattened to its first tier: the
 * contract has no room for a tier boundary, and the first tier is the one a
 * single modelled resource actually pays.
 */
function firstTier(terms) {
  const termCodes = Object.keys(terms).sort(cmp);
  if (termCodes.length === 0) return null;
  const dimensions = Object.values(terms[termCodes[0]].priceDimensions ?? {});
  if (dimensions.length === 0) return null;
  dimensions.sort((a, b) => Number(a.beginRange ?? 0) - Number(b.beginRange ?? 0));
  return dimensions[0];
}

/**
 * Read one region's offer file and return the rates worth keeping.
 *
 * Two passes rather than one: `products` and `terms.OnDemand` are separate
 * subtrees, and depending on the order AWS happens to emit them would make the
 * build fail silently the day that order changed. The products kept after
 * filtering number in the thousands, so the second pass has a small map to
 * consult and memory stays flat.
 */
export async function extract(path, offer, region) {
  const kept = new Map();
  await walk(path, 'products', (sku, product) => {
    const attributes = product.attributes ?? {};
    if (attributes.regionCode !== region) return;
    if (attributes.currentGeneration && attributes.currentGeneration !== 'Yes') return;
    if (EXTENDED_SUPPORT.test(attributes.usagetype ?? '')) return;
    const slice = sliceFor(offer.slices, product);
    if (!slice) return;
    kept.set(sku, {
      serviceIds: [slice.serviceId, ...(slice.alsoAs ?? [])],
      usageType: attributes.usagetype ?? '',
      attributes: whitelisted(attributes),
    });
  });

  const rates = [];
  await walk(path, 'terms.OnDemand', (sku, terms) => {
    const product = kept.get(sku);
    if (!product) return;
    const dimension = firstTier(terms);
    if (!dimension) return;
    const unit = UNITS.get(String(dimension.unit ?? '').toLowerCase());
    if (!unit) return;
    const usd = Number(dimension.pricePerUnit?.USD);
    if (!Number.isFinite(usd)) return;
    for (const serviceId of product.serviceIds) {
      rates.push({
        serviceId,
        region,
        sku,
        usageType: product.usageType,
        unit,
        usd,
        attributes: product.attributes,
      });
    }
  });

  return { rates, products: kept.size };
}

// --- download ----------------------------------------------------------------

/**
 * Fetch a region's offer file to disk, hashing as it goes. Kept on disk rather
 * than in memory because it can be half a gigabyte, and because the two parsing
 * passes both need to read it.
 */
async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);

  const hash = createHash('sha256');
  let bytes = 0;
  // Downloaded to a sibling name and renamed on success, so an interrupted run
  // cannot leave behind a half-file that a later run mistakes for a cache hit.
  const partial = `${path}.part`;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(partial)
  );

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== bytes) {
    await rm(partial, { force: true });
    throw new Error(`GET ${url} returned ${bytes} bytes, but declared ${declared}`);
  }

  await rename(partial, path);
  return { sha256: hash.digest('hex'), bytes };
}

/** Hashes an existing file without reading it into memory; some are half a gigabyte. */
async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- build -------------------------------------------------------------------

/**
 * Which region files exist for each offer. A region an offer is not sold in is
 * reported and left out; it becomes a gap in the snapshot rather than a rate
 * borrowed from somewhere else.
 */
async function planJobs(offers) {
  const jobs = [];
  await mapWithConcurrency(offers, CONCURRENCY, async (offer) => {
    const index = await fetchJson(
      `${PRICING_HOST}/offers/v1.0/aws/${offer.offerCode}/current/region_index.json`
    );
    const missing = REGIONS.filter((region) => !index.regions?.[region]);
    if (missing.length > 0) {
      console.log(`  ${offer.offerCode}: not sold in ${missing.join(', ')}; left as a gap`);
    }
    for (const region of REGIONS) {
      if (!index.regions?.[region]) continue;
      jobs.push({ offer, region, url: PRICING_HOST + index.regions[region].currentVersionUrl });
    }
  });
  // Largest offers first, so the long pole starts while the small files finish.
  jobs.sort((a, b) => cmp(a.offer.offerCode, b.offer.offerCode) || cmp(a.region, b.region));
  return jobs;
}

async function collectRegion(job, workDir, cacheDir, parseLock) {
  const { offer, region } = job;
  const name = `${offer.offerCode}.${region}.json`;
  const cached = cacheDir ? join(cacheDir, name) : null;
  const path = cached ?? join(workDir, name);

  const started = Date.now();
  const file =
    cached && (await exists(cached)) ? await hashFile(cached) : await download(job.url, path);
  const downloaded = Date.now();

  const { header, rates, products } = await parseLock(async () => ({
    header: await readHeader(path),
    ...(await extract(path, offer, region)),
  }));
  if (!cached) await rm(path, { force: true });

  console.log(
    `  ${offer.offerCode} ${region}: ${mib(file.bytes)} in ${((downloaded - started) / 1000).toFixed(0)}s, ` +
      `${products} products kept, ${rates.length} rates in ${((Date.now() - downloaded) / 1000).toFixed(0)}s`
  );

  return {
    rates,
    source: {
      offerCode: offer.offerCode,
      region,
      version: header.version,
      publicationDate: header.publicationDate,
      sha256: file.sha256,
      bytes: file.bytes,
    },
  };
}

function assemble(collected) {
  const rates = [];
  const seen = new Set();
  for (const { rates: batch } of collected) {
    for (const rate of batch) {
      const key = `${rate.serviceId}\u0000${rate.region}\u0000${rate.sku}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rates.push(rate);
    }
  }
  rates.sort(
    (a, b) => cmp(a.serviceId, b.serviceId) || cmp(a.region, b.region) || cmp(a.sku, b.sku)
  );

  const sources = [];
  const distinct = new Set();
  for (const { source } of collected) {
    const key = `${source.offerCode}\u0000${source.publicationDate}\u0000${source.version}`;
    if (distinct.has(key)) continue;
    distinct.add(key);
    sources.push({
      offerCode: source.offerCode,
      publicationDate: source.publicationDate,
      version: source.version,
    });
  }
  sources.sort((a, b) => cmp(a.offerCode, b.offerCode) || cmp(a.version, b.version));

  return sortedKeys({
    version: SNAPSHOT_VERSION,
    currency: 'USD',
    regions: [...REGIONS].sort(cmp),
    sources,
    rates,
  });
}

export function enforceBudget(inflated, gzipped) {
  const problems = [];
  if (gzipped.length > MAX_GZIP_BYTES) {
    problems.push(
      `gzipped payload is ${mib(gzipped.length)}, over the ${mib(MAX_GZIP_BYTES)} limit`
    );
  }
  if (inflated.length > MAX_INFLATED_BYTES) {
    problems.push(
      `inflated payload is ${mib(inflated.length)}, over the ${mib(MAX_INFLATED_BYTES)} limit`
    );
  }
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error::${problem}`);
    throw new Error('Payload is over budget. Narrow the whitelist rather than the compression.');
  }
}

function parseArgs(argv) {
  const options = { check: false, cacheDir: null, offers: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--cache-dir') options.cacheDir = resolve(argv[(i += 1)]);
    else if (arg === '--offer') options.offers.push(argv[(i += 1)]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const selected =
    options.offers.length > 0
      ? OFFERS.filter((offer) => options.offers.includes(offer.offerCode))
      : OFFERS;
  if (selected.length === 0) throw new Error('No offers selected.');

  // Confirms the offer codes still exist before spending twenty minutes on a
  // download that would end in a 404 halfway through.
  const index = await fetchJson(OFFER_INDEX);
  const unknown = selected.filter((offer) => !index.offers?.[offer.offerCode]);
  if (unknown.length > 0) {
    throw new Error(`Unknown offer code(s): ${unknown.map((o) => o.offerCode).join(', ')}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'infracanvas-price-'));
  if (options.cacheDir) await mkdir(options.cacheDir, { recursive: true });

  let peakRss = process.memoryUsage.rss();
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }, 250).unref();

  let collected;
  try {
    console.log(`Reading ${selected.length} offers across ${REGIONS.join(', ')}`);
    const jobs = await planJobs(selected);
    console.log(`${jobs.length} region files to read`);
    const parseLock = createLock();
    collected = await mapWithConcurrency(jobs, CONCURRENCY, (job) =>
      collectRegion(job, workDir, options.cacheDir, parseLock)
    );
  } finally {
    clearInterval(rssTimer);
    await rm(workDir, { recursive: true, force: true });
  }

  const snapshot = assemble(collected);
  const inflated = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
  const gzipped = gzipSync(inflated, { level: 9 });
  enforceBudget(inflated, gzipped);

  const manifest = sortedKeys({
    snapshotVersion: SNAPSHOT_VERSION,
    regions: [...REGIONS].sort(cmp),
    payload: {
      file: PAYLOAD_NAME,
      sha256: sha256(gzipped),
      gzipBytes: gzipped.length,
      inflatedBytes: inflated.length,
      rates: snapshot.rates.length,
    },
    sources: collected
      .map(({ source }) => source)
      .sort((a, b) => cmp(a.offerCode, b.offerCode) || cmp(a.region, b.region)),
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `\n${snapshot.rates.length} rates, ${mib(inflated.length)} inflated, ` +
      `${mib(gzipped.length)} gzipped, built in ${elapsed}s, peak RSS ${mib(peakRss)}`
  );

  if (options.check) {
    const committed = await readFile(join(OUT_DIR, PAYLOAD_NAME)).catch(() => null);
    const committedManifest = await readFile(join(OUT_DIR, MANIFEST_NAME), 'utf8').catch(
      () => null
    );
    const drift = [];
    if (committed === null || sha256(committed) !== sha256(gzipped)) drift.push(PAYLOAD_NAME);
    if (committedManifest !== manifestText) drift.push(MANIFEST_NAME);
    if (drift.length > 0) {
      console.log(
        `::error::${drift.join(' and ')} differ from a fresh build. Run the build and commit the result.`
      );
      return 1;
    }
    console.log('Committed snapshot matches a fresh build.');
    return 0;
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, PAYLOAD_NAME), gzipped);
  await writeFile(join(OUT_DIR, MANIFEST_NAME), manifestText);
  console.log(
    `Wrote ${join('data/pricing', PAYLOAD_NAME)} and ${join('data/pricing', MANIFEST_NAME)}`
  );
  return 0;
}

// Importable by the test suite, which exercises the budget check and the
// parser's behaviour on a truncated offer file without touching the network.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
