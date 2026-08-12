# AWS price snapshot

`aws-prices.v1.json.gz` is a slice of the AWS Price List, built ahead of time and committed so that
a cost estimate is reproducible, testable, and available without credentials or a network.

The alternatives were worse. Calling the Price List Query API at request time needs AWS credentials
this product does not ask for, is rate limited, and makes the same architecture price differently on
two consecutive requests, so no figure could be asserted in a test. Hard-coding a dozen rates is
honest for a demo and wrong within a quarter.

## What is in it

- **On-demand, USD, first tier.** Reserved, Spot and Savings Plan terms are discarded: they describe
  commitments this product does not model. Tiered rates are flattened to their first tier, which is
  what a single modelled resource pays.
- **Four regions** — `us-east-1`, `us-west-2`, `eu-west-1`, `eu-central-1`. Anything else is a gap.
  `findRate` returns `null` for a fifth region rather than quietly answering with a neighbour's
  price, because a wrong number that looks right is worse than a missing one.
- **Current-generation hardware only.** A rate whose product carries `currentGeneration: No` is
  dropped: pricing a t2 produces a number nobody should act on.
- **Seven product attributes** — `instanceType`, `databaseEngine`, `storageClass`,
  `deploymentOption`, `cacheEngine`, `memory`, `vcpu`. The rest of the `attributes` object is where
  most of the bytes are, and it prices nothing.
- **The services in `packages/core/src/aws-services.ts`**, which is the set the canvas can place.

## What is deliberately not in it

- **Reserved Instances, Savings Plans and Spot.** Out of scope for the cost model.
- **Anything whose unit is not in `PriceUnit`.** The snapshot's unit vocabulary is a closed set —
  `Hrs`, `GB-Mo`, `GB`, `Requests`, `IOPS-Mo`, `ACU-Hr`, `LCU-Hrs`, `vCPU-Hours`. AWS spells the same
  unit several ways across offers, so `Hours`, `hours` and `Hrs` are canonicalised to one. A unit
  with no canonical form is dropped rather than guessed at, and that has consequences worth knowing:

  | Dropped                                                    | Why                                                               |
  | ---------------------------------------------------------- | ----------------------------------------------------------------- |
  | Lambda duration (`Lambda-GB-Second`)                       | `GB-Second` is not in `PriceUnit`; only Lambda requests remain    |
  | Fargate task memory (`GB-Hours`)                           | `GB-Hours` is not `GB-Mo`, and treating it as one is a 730x error |
  | DynamoDB capacity units (`ReadCapacityUnit-Hrs` and so on) | Not in `PriceUnit`; on-demand request pricing is kept             |

  Widening `PriceUnit` is a change to the contract in `packages/core/src/pricing/snapshot.ts`, and
  therefore a reviewable one, which is the point.

- **Non-Linux, dedicated-tenancy and licence-included EC2.** The attribute whitelist has no room for
  `operatingSystem` or `tenancy`, so the snapshot keeps one canonical rate per instance type: Linux,
  shared tenancy, no pre-installed software, no licence. Keeping the rest would put six rates in the
  payload that look identical and disagree about the price.
- **Database engines the canvas does not offer.** RDS is narrowed to PostgreSQL, MySQL and MariaDB,
  Aurora to Aurora PostgreSQL and Aurora MySQL, and ElastiCache to Redis and Memcached. Oracle and
  SQL Server cannot be placed on the canvas, so their rates would be dead weight.
- **Extended support surcharges.** ElastiCache, Aurora, OpenSearch and EKS meter a per-hour fee for
  staying on an engine version past its end of life. It is an on-demand rate carrying the same
  instance type as the node itself, so it survives every other filter and would answer a query for a
  `cache.t3.micro` with a deprecation fee instead of a price.
- **AWS Batch.** It publishes no offer file; Batch bills through EC2 and Fargate.
- **Data transfer between regions.** A rate is kept only when its product names the region it was
  fetched for, which excludes the cross-region transfer matrix.
- **Nine catalog services that survive no unit at all** — `athena`, `acm`, `x-ray`, `textract`,
  `polly`, `rekognition`, `comprehend`, `transcribe` and `translate`. They bill in units such as
  `Terabytes`, `Traces`, `Pages`, `Characters` and `Minutes`, none of which are in `PriceUnit`. They
  are read as unpriced, which is the honest answer until the unit vocabulary grows.

## Rebuilding

```bash
node scripts/ci/build-price-snapshot.mjs            # rebuild in place
node scripts/ci/build-price-snapshot.mjs --check    # rebuild elsewhere and diff
node scripts/ci/build-price-snapshot.mjs --cache-dir .cache/pricing   # keep the downloads
node scripts/ci/build-price-snapshot.mjs --offer AmazonS3             # one offer, for iterating
```

The build reads roughly 1.9 GB of offer files, streams each one through an incremental parser, and
holds none of them in memory. It fails if the payload exceeds 2 MB gzipped or 12 MB inflated; the
answer to that failure is a narrower whitelist, not a higher compression level.

`--cache-dir` is for local iteration only. CI always downloads afresh, because a cached offer file
is a stale price.

The payload carries no timestamp and every object key is sorted, so a rebuild that finds unchanged
prices produces a byte-identical file. `MANIFEST.json` records the sha256 and byte size of every
source offer file, and the `publicationDate` each one declares — the date that actually matters —
but no wall-clock time of its own, so a scheduled rebuild opens no pull request unless a price moved.

`.github/workflows/price-snapshot.yml` rebuilds monthly and opens a pull request when the payload
changes.

## Reading it

```ts
import { findRate, loadPriceSnapshot } from '@infracanvas/core/pricing';

const snapshot = loadPriceSnapshot();
const rate = findRate(snapshot, {
  serviceId: 'ec2',
  region: 'us-east-1',
  attributes: { instanceType: 'm5.large' },
});
```

Node only. The subpath export exists so `apps/web` cannot reach it: 2 MB of gzip in the browser
bundle would fail the Gate 6 budget outright. Cost figures reach the browser through the API.

`findRate` matches every attribute in the query exactly and returns `null` otherwise. It never
falls back to a nearest match.

## Spot checks

Ten rates read out of the committed payload and compared against the AWS Pricing Calculator and the
published on-demand pricing pages, on 2026-08-10. Every one agrees to the cent.

| Service                               | Region       | SKU                | Usage type                       | Unit  | Snapshot | AWS    |
| ------------------------------------- | ------------ | ------------------ | -------------------------------- | ----- | -------- | ------ |
| EC2 m5.large, Linux                   | us-east-1    | `6C86BEPQVG73ZGGR` | `BoxUsage:m5.large`              | Hrs   | 0.096    | 0.096  |
| EC2 m5.large, Linux                   | eu-west-1    | `FP7Z96TTU3VFSX2H` | `EU-BoxUsage:m5.large`           | Hrs   | 0.107    | 0.107  |
| EC2 t3.micro, Linux                   | us-east-1    | `CRAJUW7BTXFMT2UJ` | `BoxUsage:t3.micro`              | Hrs   | 0.0104   | 0.0104 |
| EBS gp3 volume                        | us-east-1    | `JG3KUJMBRGHV3N8G` | `EBS:VolumeUsage.gp3`            | GB-Mo | 0.08     | 0.08   |
| RDS db.t3.micro PostgreSQL, Single-AZ | us-east-1    | `TGN7QDJF2AGFU9XA` | `InstanceUsage:db.t3.micro`      | Hrs   | 0.018    | 0.018  |
| RDS db.t3.micro PostgreSQL, Single-AZ | eu-central-1 | `VJNEKAFRR6K9PXWQ` | `EUC1-InstanceUsage:db.t3.micro` | Hrs   | 0.021    | 0.021  |
| Aurora PostgreSQL db.r6g.large        | us-east-1    | `4U9P9G87PY8QVQH5` | `InstanceUsage:db.r6g.large`     | Hrs   | 0.26     | 0.26   |
| ElastiCache cache.t3.micro Redis      | us-east-1    | `YJHUKPU3DN6YKD58` | `NodeUsage:cache.t3.micro`       | Hrs   | 0.017    | 0.017  |
| Application Load Balancer             | us-east-1    | `37CUWUT8GSNQEPUV` | `LoadBalancerUsage`              | Hrs   | 0.0225   | 0.0225 |
| NAT Gateway                           | us-east-1    | `M2YSHUBETB3JX4M4` | `NatGateway-Hours`               | Hrs   | 0.045    | 0.045  |

Two more checked at the same time: S3 Standard storage in `us-east-1` (`WP9ANXZGBYYSGJEA`) at
$0.023/GB-Mo, and EFS Standard in `us-east-1` (`YFV3RHAD3CDDP3VE`) at $0.30/GB-Mo.

SKUs move when AWS republishes an offer, so treat the SKU column as a pointer into the payload of
the day rather than a permanent identifier. The rates are the part worth rechecking.
