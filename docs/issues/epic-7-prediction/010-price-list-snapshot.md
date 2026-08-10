---
title: '[ci] Versioned AWS Price List snapshot built in CI'
labels: tier:2, size:m, area:ci, epic:7-prediction
---

### Epic

#8

### Context

Cost prediction needs prices, and there are three ways to get them. Calling the Price List Query API
at request time needs AWS credentials the user has not given us, is rate limited, and makes a cost
figure irreproducible: the same architecture priced twice can differ, and neither number can be
tested against. Hard-coding a handful of rates is honest for a demo and wrong within a quarter.
What is left is a snapshot, built ahead of time, versioned, and read from disk, which is also the
only option that works on an aeroplane.

The obstacle is size. The bulk offer file for EC2 alone is a single JSON document well past a
gigabyte, because it enumerates every instance type in every region under on-demand, every reserved
term and every purchase option. It cannot be committed, it cannot be held in memory, and
`JSON.parse` on it is not an option. The build therefore fetches the per-region offer files rather
than the global one, streams them through an incremental parser, and keeps a small subset:

- only the services present in `packages/core/src/aws-services.ts`, which is the set the canvas can
  actually place;
- only `OnDemand` terms in USD, discarding Reserved, Spot and Savings Plans, which describe
  commitments this product does not model;
- only four regions -- `us-east-1`, `us-west-2`, `eu-west-1`, `eu-central-1` -- covering the defaults
  the canvas offers, with an explicit gap rather than a silent substitution for anything else;
- only current-generation instance families, because pricing a t2 gives a number nobody should act
  on;
- a fixed whitelist of product attributes, not the whole `attributes` object, which is where most of
  the bytes are.

That reduces roughly two gigabytes of input to a payload that must stay under 2MB gzipped. The limit
is enforced by the build rather than left as an aspiration, because the natural failure here is a
whitelist quietly widening until the artefact is too big to commit.

The output is committed rather than published as a release asset. A release asset needs a network
call and an unauthenticated download path to be useful offline, which is the thing the snapshot
exists to avoid; 2MB in the repository is cheaper than that. The payload contains no timestamp and
its keys are sorted, so a scheduled rebuild that finds unchanged prices produces a byte-identical
file and opens no pull request.

Spec: `packages/core/src/aws-services.ts`

### Contract

```typescript
// packages/core/src/pricing/snapshot.ts
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

/** Reads and inflates the committed snapshot. Node only; never import from web code. */
export function loadPriceSnapshot(path?: string): PriceSnapshot;

/** Exact lookup. Returns null rather than the nearest match, because a wrong
 *  price that looks right is worse than a missing one. */
export function findRate(
  snapshot: PriceSnapshot,
  query: { serviceId: string; region: string; attributes: Record<string, string> }
): PriceRate | null;
```

```
data/pricing/aws-prices.v1.json.gz   the payload, sorted, no timestamp
data/pricing/MANIFEST.json           offer codes, publication dates, sha256, byte sizes
```

`MANIFEST.json` records no wall-clock time either. The source offer files carry their own
`publicationDate`, which is the date that actually matters, and a `generatedAt` field would make
every scheduled run a diff.

```bash
node scripts/ci/build-price-snapshot.mjs            # rebuild from the AWS endpoints
node scripts/ci/build-price-snapshot.mjs --check    # rebuild to a temporary file and diff
```

The loader is exported from a `./pricing` subpath rather than the package root, and `apps/web` must
not import it: a 2MB gzip in the browser bundle would fail the Gate 6 budget outright.

### Files

- CREATE `scripts/ci/build-price-snapshot.mjs`
- CREATE `data/pricing/aws-prices.v1.json.gz`
- CREATE `data/pricing/MANIFEST.json`
- CREATE `packages/core/src/pricing/snapshot.ts`
- CREATE `packages/core/src/pricing/snapshot.test.ts`
- MODIFY `packages/core/tsup.config.ts` - add the `src/pricing/snapshot.ts` entry
- MODIFY `packages/core/package.json` - add the `./pricing` export
- CREATE `.github/workflows/price-snapshot.yml` - monthly rebuild that opens a pull request on change
- CREATE `data/pricing/README.md` - what is included, what is deliberately excluded, how to rebuild

### Acceptance Criteria

- [ ] The build streams the offer files and never holds a whole one in memory
- [ ] The build fails when the gzipped payload exceeds 2MB or the inflated payload exceeds 12MB
- [ ] Running the build twice against the same source offers produces byte-identical output
- [ ] Reserved, Spot and Savings Plan terms are absent from the payload
- [ ] Every rate carries a SKU that appears in the source offer file
- [ ] A region outside the four supported is reported as unpriced rather than substituted with another region's rate
- [ ] `findRate` returns null for an unknown attribute combination rather than the closest match
- [ ] `loadPriceSnapshot` reads the committed file with no network access and no AWS credentials
- [ ] Ten spot-checked rates match the AWS Pricing Calculator to the cent, recorded in `data/pricing/README.md`
- [ ] `pnpm --filter @infracanvas/web build` does not include the snapshot, and the bundle check still passes

### Required Tests

- `loads and inflates the committed snapshot`
- `finds an exact rate by service, region, and attributes`
- `returns null for a region that is not in the snapshot`
- `returns null rather than a near match for an unknown instance type`
- `rejects a snapshot whose version does not match the loader`
- `keeps rates sorted so the encoding is stable`
- `fails the size check when the payload grows past the limit`
- `parses a truncated offer file as an error rather than a partial snapshot`

### Performance Budget

The full rebuild finishes in under 10 minutes on a GitHub-hosted runner with peak resident memory
under 1GB, both reported by the workflow. `loadPriceSnapshot` completes in under 150ms cold and the
result is memoised for the process; measured in the vitest suite.

### Out of Scope

- Do not compute any cost; `020-cost-model.md` consumes this snapshot
- Do not add Reserved Instance, Savings Plan, or Spot pricing
- Do not call the Price List Query API at runtime, or add any AWS SDK dependency to the request path
- Do not import the snapshot from `apps/web`; cost figures reach the browser through the API
- Do not extend `packages/core/src/aws-services.ts` to add services just so they can be priced

### Dependencies

none

### Verification

```bash
node scripts/ci/build-price-snapshot.mjs --check
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core build
pnpm typecheck
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
ls -l data/pricing/aws-prices.v1.json.gz
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
