# Committed price snapshots

Cost is deterministic and comes from these files, not from a live API call. A cost that changes
between two runs over the same architecture is not something a user can act on, and a unit test
cannot assert against a network.

Each file records the AWS price list version and publication date it was taken from, and every
`CostEstimate` carries that provenance in `priceSource`, so any number on the canvas can be traced
back to a specific published price list.

These per-resource files are the interim source. The repository-wide snapshot built by
`scripts/ci/build-price-snapshot.mjs` (epic 7) replaces them once the cost model reads it directly;
until then, keeping the reference resource's prices beside the resource is what lets the contract be
implemented and tested without a network.

## Refreshing a file

Take the rates from the same published price list rather than from the AWS pricing web pages, which
round and omit the deployment option:

```bash
curl -s https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/region_index.json
```

Update `priceListVersion` and `capturedAt` in the same commit as the rates. A snapshot whose
provenance does not match its numbers is worse than a stale one, because it cannot be audited.
