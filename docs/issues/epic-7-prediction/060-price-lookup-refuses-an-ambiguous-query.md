---
title: '[ir] Price lookup refuses an ambiguous query instead of answering the first match'
labels: tier:2, size:s, area:ir, epic:7-prediction
---

### Epic

#8

### Context

`findRate` in `packages/core/src/pricing/snapshot.ts` promises an exact lookup, and its own docstring
states the reason: _"Returns null rather than the nearest match, because a wrong price that looks
right is worse than a missing one."_ It does not keep that promise.

Matching is `wanted.every(([name, value]) => rate.attributes[name] === value)` over
`Object.entries(query.attributes)`. `Array.prototype.every` on an empty array is `true`, so a query
naming no attributes matches every rate in the bucket, and the loop returns the first one.

This is not a theoretical edge. Most services in the committed snapshot do not discriminate on
attributes at all — the discriminator is `usageType`, which `PriceRate` carries and the query type has
no field for. In `us-east-1` the snapshot holds 494 `lambda` rates, 5 `alb` rates and 7 `fargate`
rates, **all** with `attributes: {}`. So the obvious Lambda cost model —
`findRate(snapshot, { serviceId: 'lambda', region: 'us-east-1', attributes: {} })` — returns
`Lambda-Managed-Instances-c7i.8xlarge-Management-Hours`, an EC2 management hour billed in `Hrs`, when
what a Lambda model needs is the `Request` rate at $0.0000002 per request. The figure is wrong by
orders of magnitude and looks entirely plausible on a cost panel.

Twenty-three resource contracts are queued to be written against this function
(`docs/issues/epic-2-ir/040-resource-contract-registry.md` establishes the seven-part contract and
RDS is the only implementation so far). Every one of them will write a `cost` model on top of this
lookup. Fixing it afterwards means re-verifying twenty-three cost models against a lookup whose
answers changed; fixing it first costs one small pull request.

Two alternatives were considered. Requiring `usageType` on every query was rejected because RDS and
EC2 genuinely do discriminate on attributes and naming a usage type there is redundant noise.
Returning the first match but logging a warning was rejected because nothing reads the log and the
wrong number still reaches the panel.

The rule adopted instead is that **a query must identify exactly one rate**. Matching several is a
missing discriminator rather than a result, so it returns `null` for the same reason matching none
does: the caller asked a question this snapshot cannot answer. That keeps the docstring's promise
without requiring a discriminator where the attributes already suffice.

Spec: `docs/issues/epic-7-prediction/010-price-list-snapshot.md`

### Contract

```typescript
// packages/core/src/pricing/snapshot.ts

export function findRate(
  snapshot: PriceSnapshot,
  query: {
    serviceId: string;
    region: string;
    attributes: Record<string, string>;
    /** The discriminator for services whose rates share their attributes. */
    usageType?: string;
  }
): PriceRate | null;
```

Behaviour, exhaustively:

| Matches after filtering | Result    |
| ----------------------- | --------- |
| exactly one             | that rate |
| none                    | `null`    |
| more than one           | `null`    |

`usageType`, when supplied, is compared with `===` against `PriceRate.usageType`. When omitted it
places no constraint. Attribute matching is unchanged: every named attribute must be equal.

`PriceRate` already carries `usageType: string`; no change to the snapshot payload, the build script,
or `PRICE_SNAPSHOT_VERSION` is required or permitted.

### Files

- `packages/core/src/pricing/snapshot.ts` — MODIFY: add `usageType` to the query type; replace the
  first-match loop with a filter that returns a rate only when exactly one survives; rewrite the
  docstring to state the ambiguity rule and why it exists.
- `packages/core/src/pricing/snapshot.test.ts` — MODIFY: add the cases below.

### Acceptance Criteria

- [ ] A query whose attributes and usage type match no rate returns `null`.
- [ ] A query that matches more than one rate returns `null` rather than the first of them.
- [ ] A query naming no attributes against a service whose rates all carry empty attributes returns `null`.
- [ ] Supplying `usageType` selects a single rate where the attributes alone do not discriminate.
- [ ] A query that matches exactly one rate returns that rate, unchanged from today's behaviour.
- [ ] `PRICE_SNAPSHOT_VERSION` and the committed payload are untouched.

### Required Tests

- `returns null when the query names nothing that tells the rates apart` — asserts that
  `lambda`/`us-east-1` holds more than one rate, that every one carries no attributes, and that an
  empty-attribute query returns `null`. This is the regression case and must fail against the current
  implementation.
- `finds a rate by usage type where the attributes do not discriminate` — `lambda`/`us-east-1` with
  `usageType: 'Request'` returns a rate whose unit is `Requests` and whose price is $0.0000002, the
  published figure.
- `returns null when a usage type names no rate` — an unknown `usageType` returns `null` rather than
  falling back to an attribute-only match.
- `finds an exact rate by service, region, and attributes` — the existing `ec2`/`m5.large` case still
  returns `BoxUsage:m5.large`, proving the stricter rule did not break a discriminating query.
- `returns null rather than a near match for an unknown instance type` — unchanged.
- `returns null for a region the snapshot does not carry` — unchanged.

### Performance Budget

`findRate` moves from an early-returning loop to a full scan of the bucket. The largest bucket in the
committed snapshot is under 1,000 rates and lookups are per resource, not per request, so the change
is immaterial; the existing suite must still complete inside its current time. No new budget.

### Out of Scope

- Rewriting `resources/rds-instance/cost.ts` to use the snapshot. It reads a hand-shaped
  `rds-us-east-1.json` today and moving it is its own issue with its own golden-file risk.
- Adding `usageType` to any existing caller. There are none in production code.
- The `RateTable` abstraction and per-architecture rate bundles.
- Changing the build script, the payload, or the whitelisted attribute set.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/core exec vitest run src/pricing/snapshot.test.ts
pnpm --filter @infracanvas/core exec tsc --noEmit
```

Then prove the regression case is real rather than vacuous, by asserting it fails against the
implementation it replaces:

```bash
git stash push -- packages/core/src/pricing/snapshot.ts
pnpm --filter @infracanvas/core exec vitest run src/pricing/snapshot.test.ts -t "tell the rates apart"
git stash pop
```
