---
title: '[ir] Patch preview carrying the cost, availability and finding deltas of a proposal'
labels: tier:1, size:l, area:ir, area:api, area:brain, epic:13-agent
---

### Epic

#117

### Context

A proposal without its price is a suggestion to spend money blind. "Add a read replica" and "move this
to Multi-AZ" are the same sentence to a user until one of them says plus 340 dollars a month and the
other says plus 31; and the reason the copilot is allowed to touch an architecture at all is that the
consequences of a change can be stated before it is accepted. This issue computes those consequences by
running the prediction plane over the patched document and diffing it against the current one.

The numbers come from the deterministic plane in `packages/core/src/prediction/` (#8), never from the
model. Asking the model to estimate the delta was considered because it is nearly free, and rejected
because it produces a plausible figure that no user can check, which is worse than no figure: a cost
line from `docs/issues/epic-7-prediction/020-cost-model.md` carries the SKU its rate came from, and an
availability figure from `docs/issues/epic-7-prediction/050-availability-and-slo.md` (#104) says
whether it is a published AWS SLA or a
modelled one. Reporting only the total was also rejected. A delta of plus 41 dollars with no breakdown
cannot be argued with, and the whole design of the cost model -- every line naming the assumptions its
quantity came from -- exists so that a user who disagrees can find the line rather than distrust the
total.

**The prediction plane is TypeScript and the copilot is Python, and that gap has to be crossed
somewhere.** Three ways were considered. Reimplementing cost, availability and the Well-Architected
rules in Python was rejected immediately: two cost models drift silently, the accuracy fixtures that
pin the numbers to the AWS Pricing Calculator live in the TypeScript suite, and a disagreement between
them would show up as a user complaint rather than a failing test. Shelling out to Node from Python per
call was rejected because a process start per preview does not fit an interactive budget and turns
error handling into stderr parsing. What is left is one internal HTTP endpoint on `apps/api`, which
already depends on `packages/core`, called by the brain over the loopback interface with a shared
service token. That endpoint is deliberately **pure**: the caller supplies the document and the patch,
the endpoint touches no database and has no notion of a user, so there is no ownership check in it to
get wrong and no path by which it could return somebody else's architecture.

**An unpriced or unmodelled resource is reported, never counted as zero.** This is already the rule in
`docs/issues/epic-7-prediction/020-cost-model.md` and it matters more in a delta, because a resource
that cannot be priced on the
patched side makes the reported change a lower bound rather than a wrong number: adding something
unpriced looks free, and free is the single most misleading thing a preview could say. So each
dimension carries a `completeness`, every unknown carries a reason, and a partial delta may not be
rendered as an exact figure -- which `060-copilot-chat-surface.md` is held to as an acceptance
criterion.

**Caching exists because a comparison asks four questions about one document.** The expensive half of a
preview is the baseline: cost, availability and every rule evaluated over the whole current document,
which is identical for every proposal computed against it. That is cached by content, keyed on the
semantic `irDigest` together with the price snapshot version, the IR version and a digest of the
assumption set, so a stale entry is not possible and no invalidation logic is needed. Whole previews
are cached on the same principle, keyed by both digests, which makes a repeated identical proposal free
and makes the four options of a `compare_options` call cost one baseline instead of four.

Spec: `docs/issues/epic-7-prediction/020-cost-model.md`

### Contract

```typescript
// packages/core/src/ir/preview.ts
import type { ArchitectureIr, ResourceKind } from '@infracanvas/ir-schema';
import type { Assumption } from '../prediction/prediction';
import type { CostLine } from '../prediction/cost';
import type { RuleFinding } from '../resources/contract';
import type { IrPatch, PatchProblem } from './patch';

export const PATCH_PREVIEW_VERSION = 1;

/** `partial` means at least one resource could not be priced or modelled. */
export type Completeness = 'complete' | 'partial';

export interface PreviewUnknown {
  resourceId: string;
  kind: ResourceKind;
  dimension: 'cost' | 'availability' | 'rules';
  /** Plain language, shown to the user: "no cost model for elasticache". */
  reason: string;
  /** `before`, `after`, or `both`. A resource unknown only after the patch makes the delta a bound. */
  side: 'before' | 'after' | 'both';
}

export interface ResourceCostDelta {
  resourceId: string;
  change: 'added' | 'removed' | 'changed';
  monthlyUsdBefore: number;
  monthlyUsdAfter: number;
  monthlyUsdDelta: number;
  /** Only the lines that moved. An unchanged line is noise on a diff card. */
  lines: CostLine[];
}

export interface CostDelta {
  monthlyUsdBefore: number;
  monthlyUsdAfter: number;
  monthlyUsdDelta: number;
  completeness: Completeness;
  byResource: ResourceCostDelta[];
  unpriced: PreviewUnknown[];
}

export interface AvailabilityDelta {
  /** Composite availability as a fraction, for example 0.9995. */
  before: number;
  after: number;
  delta: number;
  downtimeMinutesBefore: number;
  downtimeMinutesAfter: number;
  weakestBefore: string;
  weakestAfter: string;
  completeness: Completeness;
  unmodelled: PreviewUnknown[];
}

export interface FindingDelta {
  appeared: RuleFinding[];
  resolved: RuleFinding[];
  /** Findings present on both sides. Counted rather than listed. */
  unchangedCount: number;
}

export interface PatchPreview {
  previewVersion: typeof PATCH_PREVIEW_VERSION;
  basedOnIrDigest: string;
  patchDigest: string;
  /** False when the patch does not apply. Every delta is then zero and `problems` says why. */
  applicable: boolean;
  problems: PatchProblem[];
  touchedNodeIds: string[];
  cost: CostDelta;
  availability: AvailabilityDelta;
  findings: FindingDelta;
  /** Every assumption either side depended on, so a figure can be argued with. */
  assumptions: Assumption[];
  baselineCacheHit: boolean;
  computedMs: number;
}

export interface PreviewResult {
  preview: PatchPreview;
  /** `invertPatch` against the pre-patch document. Null when the patch does not apply. */
  inverse: IrPatch | null;
  /**
   * The patched document itself, so that applying later is a write of the exact
   * bytes that were priced rather than a second application that has to agree
   * with this one. Null when the patch does not apply.
   */
  patchedIr: ArchitectureIr | null;
  patchedIrDigest: string | null;
}

export interface PreviewContext {
  region: string;
  assumptions: Assumption[];
  baselineCache: BaselineCache;
  previewCache: PreviewCache;
}

/**
 * Apply, predict, diff. Never mutates `ir`, opens no socket and reads no
 * database. An empty `patch.ops` is legal and returns the baseline with every
 * delta zero, which is how a caller asks "what does this cost today".
 */
export function previewPatch(
  ir: ArchitectureIr,
  patch: IrPatch,
  ctx: PreviewContext
): PreviewResult;

/** Every Well-Architected finding in a document, by walking the contract registry. */
export function collectFindings(ir: ArchitectureIr): RuleFinding[];
```

```typescript
// packages/core/src/ir/preview-cache.ts
export const DEFAULT_BASELINE_ENTRIES = 32;
export const DEFAULT_PREVIEW_ENTRIES = 256;

/**
 * Content-addressed, so an entry cannot go stale and there is no invalidation.
 * The key folds in the price snapshot version and IR_VERSION, so bumping either
 * misses rather than serving a figure computed under the old one.
 */
export function baselineKey(irDigest: string, ctx: PreviewContext): string;
export function previewKey(irDigest: string, patchDigest: string, ctx: PreviewContext): string;

export function createBaselineCache(entries?: number): BaselineCache;
export function createPreviewCache(entries?: number): PreviewCache;
```

`collectFindings` exists because nothing aggregates rules today: the Well-Architected rules live per
resource on `ResourceContract.rules` in `docs/issues/epic-2-ir/040-resource-contract-registry.md`, and
each is evaluated with a `RuleContext` carrying the node's ancestors. This walks the document, resolves
each node's contract with `getResourceContract`, builds the ancestor chain once per node, and returns
every non-null finding. A node whose kind has no contract yet contributes a `PreviewUnknown` on the
`rules` dimension rather than nothing, because "no rules fired" and "no rules exist" look identical on
a diff card otherwise.

The internal endpoint, mounted only when the token is configured:

```
POST /internal/ir/preview
  X-InfraCanvas-Service-Token: <BRAIN_SERVICE_TOKEN>
  { "ir": {...}, "patch": {...}, "region": "us-east-1", "assumptions": [...] }
  200 { "preview": {...}, "inverse": {...}, "patchedIr": {...}, "patchedIrDigest": "..." }
  400 when the body is not an IR document and a patch
  401 when the token is absent or wrong
  413 when the document exceeds the 10MB express.json limit already configured
```

```typescript
// apps/api/src/middleware/service-token.ts
/**
 * Compares with `timingSafeEqual` over fixed-length buffers, so a wrong token
 * cannot be found a byte at a time.
 *
 * When `BRAIN_SERVICE_TOKEN` is unset the internal router is not mounted at
 * all and the path 404s, rather than 401ing. A 401 tells an unauthenticated
 * caller that a credential would get them in, and a deployment with no brain
 * has no such credential to leak.
 */
export function requireServiceToken(req: Request, res: Response, next: NextFunction): void;
```

```python
# services/brain/src/brain/copilot/preview.py
class PreviewUnavailableError(RuntimeError):
    """The preview plane could not be reached or returned a non-200. Callers
    report the patch as unpriced; nobody substitutes zeros."""


class PreviewClient(Protocol):
    async def preview(self, ir: ArchitectureIr, patch: IrPatch) -> PreviewResult: ...


class HttpPreviewClient:
    def __init__(
        self,
        base_url: str,          # INTERNAL_API_URL, default http://localhost:3001
        token: str,             # BRAIN_SERVICE_TOKEN
        timeout_seconds: float = 5.0,
    ) -> None: ...

    async def preview(self, ir: ArchitectureIr, patch: IrPatch) -> PreviewResult:
        """One retry on a connection error, none on a 4xx or 5xx: a rejected
        body will be rejected identically the second time, and a turn holding a
        stream open cannot afford a retry loop."""
```

The Python models mirror the TypeScript ones field for field, and the two are pinned together by a
fixture rather than by review, the same way `fixtures/llm/reasoning-scale.json` pins the reasoning
tables in `docs/issues/epic-6-brain/030-reasoning-scale-mapping.md`. The TypeScript suite writes
`fixtures/ir/patch-preview.example.json` from a real `previewPatch` call over
`packages/ir-schema/fixtures/three-tier.json`, and the Python suite parses it with
`PatchPreview.model_validate` and asserts no field was dropped. A field added on one side and not the
other fails the other language's suite in the same pull request.

### Files

- CREATE `packages/core/src/ir/preview.ts` - the delta types and `previewPatch`
- CREATE `packages/core/src/ir/preview-cache.ts` - the two content-addressed LRU caches
- CREATE `packages/core/src/ir/findings.ts` - `collectFindings` over the contract registry
- CREATE `packages/core/src/ir/preview.test.ts`
- CREATE `packages/core/src/ir/preview-cache.test.ts`
- CREATE `packages/core/src/ir/findings.test.ts`
- CREATE `packages/core/src/ir/preview-fixture.test.ts` - writes `fixtures/ir/patch-preview.example.json`
- CREATE `fixtures/ir/patch-preview.example.json` - generated, committed, read by both languages
- CREATE `apps/api/src/middleware/service-token.ts`
- CREATE `apps/api/src/middleware/service-token.test.ts`
- CREATE `apps/api/src/routes/internal/index.ts` - the internal router, mounted only when configured
- CREATE `apps/api/src/routes/internal/preview.ts`
- CREATE `apps/api/src/routes/internal/preview.test.ts`
- CREATE `services/brain/src/brain/copilot/preview.py` - the protocol, the HTTP client, the mirrored models
- CREATE `services/brain/tests/test_preview_client.py`
- CREATE `services/brain/tests/test_preview_models.py` - the fixture parity assertion
- MODIFY `packages/core/src/index.ts` - export the preview surface
- MODIFY `apps/api/src/index.ts` - mount `/internal` when `BRAIN_SERVICE_TOKEN` is set
- MODIFY `apps/api/src/lib/env.ts` - add the optional `BRAIN_SERVICE_TOKEN`
- MODIFY `apps/api/.env.example` - document it, with how to generate one
- MODIFY `services/brain/src/brain/settings.py` - add `internal_api_url` and `brain_service_token`
- MODIFY `services/brain/pyproject.toml` - `httpx` moves from the dev extras to the runtime dependencies
- MODIFY `services/brain/README.md` - that the preview plane is the TypeScript API and why
- MODIFY `.github/workflows/gate-review.yml` - add `apps/api/src/routes/internal/` to the tier-1 path expression

### Acceptance Criteria

- [ ] A preview of a patch that adds an ElastiCache cluster reports a positive `monthlyUsdDelta` whose value equals the sum of the added resource's cost lines
- [ ] A resource with no cost model appears in `cost.unpriced` with a reason, sets `completeness: 'partial'`, and contributes nothing to either total
- [ ] A resource unpriced only after the patch records `side: 'after'`, so a renderer can say the delta is a lower bound
- [ ] Making an RDS instance Multi-AZ raises `availability.after` and reports the published SLA rather than a modelled figure
- [ ] A patch that resolves `RDS-SEC-001` lists it in `findings.resolved` and not in `findings.appeared`
- [ ] A patch whose result fails `validateIr` returns `applicable: false`, every delta zero, the validator problems, and a null `inverse` and `patchedIr`
- [ ] `patchedIr` digests to `patchedIrDigest`, so the document that was priced is the document a caller can store and later write
- [ ] An empty operation list returns the baseline with every delta exactly zero and `applicable: true`
- [ ] The second preview against the same document reports `baselineCacheHit: true` and no repeated rule evaluation, asserted by counting calls
- [ ] Two previews of the same patch against the same document return byte-identical payloads
- [ ] Changing the price snapshot version changes both cache keys, so no figure survives a snapshot bump
- [ ] `POST /internal/ir/preview` performs no database query, asserted by a test that fails the pool before calling it
- [ ] `POST /internal/ir/preview` with an absent, empty or wrong token returns 401 and logs the outcome without the token value
- [ ] `/internal/*` is not mounted at all when `BRAIN_SERVICE_TOKEN` is unset, and returns 404
- [ ] No `/internal/*` response carries an `Access-Control-Allow-Origin` header
- [ ] `HttpPreviewClient` raises `PreviewUnavailableError` on a timeout rather than returning a zero-delta preview
- [ ] `PatchPreview.model_validate` accepts the committed fixture with no extra or missing fields

### Required Tests

- `prices an added resource into the cost delta`
- `reports an unpriced resource rather than charging it zero`
- `marks a delta partial when a resource is unpriced only after the patch`
- `prefers the published sla when multi az changes availability`
- `separates findings that appeared from findings that were resolved`
- `returns applicable false with the validator problems for an unapplicable patch`
- `returns the baseline for an empty operation list`
- `reuses the cached baseline for a second patch against the same document`
- `produces identical output for the same document and patch twice`
- `changes the cache key when the price snapshot version changes`
- `reports a kind with no contract as an unknown on the rules dimension`
- `rejects a request with a wrong service token in constant time`
- `never logs the service token`
- `serves no internal route when the token is unconfigured`
- `test_preview_client_raises_rather_than_returning_zeros_on_timeout`
- `test_preview_client_retries_a_connection_error_once_and_no_more`
- `test_patch_preview_model_matches_the_committed_fixture`

### Performance Budget

With a warm baseline, a preview over a 40-resource architecture completes in under 80ms measured with
`performance.now()` over 100 iterations and asserted on the median; cold, including the baseline, under
300ms. The loopback round trip adds under 15ms, asserted in the API route test. Four concurrent
previews against one document -- the `compare_options` shape -- complete in under twice the single warm
figure, because they share one baseline. The budget is what makes the chat feel like a conversation
rather than a build, and it is the reason the baseline cache is in this issue rather than deferred.

### Out of Scope

- Do not compute latency or bottleneck deltas. `docs/issues/epic-7-prediction/030-latency-model.md`
  needs a request path the IR does not yet declare, and a latency figure derived from a guessed path
  would be the one number in this preview nobody could trace
- Do not change any model in `packages/core/src/prediction/`. This issue consumes cost, availability and
  the rules as they are, and a change needed there means the prediction issue is the one to edit
- Do not give the internal endpoint a database, a session, or a notion of a user. It stays pure, which
  is the whole reason it is safe to expose to another process
- Do not add a brain service to `docker-compose.yml`. `services/brain` has no Dockerfile, and both
  processes are started by hand as `services/brain/README.md` documents; containerising the brain is a
  deployment change and its own issue
- Do not expose `/internal` through CORS, a proxy rule, or the Vite dev proxy. Nothing in the browser
  calls it
- Do not cache in Postgres or Redis. A process-local content-addressed LRU is correct at this size, and
  a shared cache would need an invalidation story that content addressing makes unnecessary
- Do not build the diff card; `060-copilot-chat-surface.md` renders this type

### Dependencies

Blocked by `010-ir-patch-protocol.md` for `applyPatch`, `invertPatch` and the digests, by #101 for the
cost model, #104 for availability, #100 for the price snapshot, and #80 for the contract registry that
carries the Well-Architected rules. #77 and #78 supply the document shape both languages read.

### Verification

```bash
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/core typecheck
pnpm --filter @infracanvas/core build
pnpm --filter @infracanvas/api test
pnpm lint && pnpm typecheck
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest tests/test_preview_client.py tests/test_preview_models.py -v
# The endpoint refuses an unauthenticated caller and answers an authenticated one.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST localhost:3001/internal/ir/preview \
  -H 'content-type: application/json' --data '{"ir":{},"patch":{}}'
```

### Risk Tier

tier:1 - introduces a shared service credential, and `apps/api/src/middleware/` is inside Gate 7's
tier-1 path expression in `.github/workflows/gate-review.yml`, so this lands with a security review
either way

### Size

size:l - over 600 lines
