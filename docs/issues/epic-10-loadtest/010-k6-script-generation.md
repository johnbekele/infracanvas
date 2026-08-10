---
title: '[infra] Generate k6 scripts from the request paths in the IR'
labels: tier:2, size:m, area:infra, area:api, epic:10-loadtest
---

### Epic

#11

### Context

A load test is only evidence if it exercises the architecture that was deployed. A hand-written
script tests whatever its author remembered to include, and the gap between the two is invisible in
the result: a script that misses the one endpoint which fans out to the database reports a system
that scales, right up until a user sends real traffic at it.

The IR already contains the information needed to avoid guessing. It names the entry points, the
method and path of each, the payload shape each accepts, the relative share of traffic each is
expected to take, and which downstream components each one touches. Deriving the script from that
document means the test and the infrastructure are generated from one source, so they cannot
disagree about what the system is.

Two alternatives were rejected. Recording real traffic and replaying it is the better technique when
traffic exists, and none does: an experiment is a deployment of an architecture that has never
served a user. Asking a model to write the script is worse than useless here, because the failure
mode is quiet. A hallucinated path returns 404 from the load balancer without ever reaching the
application, 404s are cheap, and the run therefore reports a deployment that is faster than the real
one. A generator that can only emit paths present in the IR cannot make that mistake.

k6 rather than Locust, Artillery, or JMeter: k6 scripts are JavaScript, so the generator emits the
same language the rest of `packages/core` is written in; it ships as one static binary with no
runtime to install in the runner image; and `--out json` gives per-request samples, which the metrics
join needs and which a summary-only tool cannot provide. Locust would require a Python runtime and a
controller process in the runner task for no gain.

Generation is deterministic. The same IR and the same seed must produce byte-identical script
content, because two runs of a test that differ in their generated payloads are not comparable, and
because the calibration loop compares runs.

### Contract

```typescript
// packages/core/src/loadtest/request-paths.ts
import type { ArchitectureIr } from '../ir/types.js'; // lands with the IR epic

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestPath {
  /** Stable IR identifier. Becomes the k6 `path_id` tag, which the metrics join reads. */
  id: string;
  method: HttpMethod;
  /** Colon-parameter form as written in the IR, for example `/orders/:orderId`. */
  template: string;
  /** Relative share of iterations. Absent in the IR means an equal share. */
  weight?: number;
  /** Field shapes only. Values are generated; the IR never carries example data. */
  body?: BodyShape;
  expectStatus: number[];
  /** IR component ids this path reaches, carried through to the report. */
  touches: string[];
}

export function extractRequestPaths(ir: ArchitectureIr): RequestPath[];
```

```typescript
// packages/core/src/loadtest/k6-script.ts
export interface RampStage {
  targetRps: number;
  durationSec: number;
}

export interface K6ScriptInput {
  ir: ArchitectureIr;
  baseUrl: string;
  stages: readonly RampStage[];
  /** Seeds payload and path-parameter generation. Same seed, same bytes. */
  seed: number;
}

export interface GeneratedK6Script {
  path: 'loadtest/script.js';
  content: string;
  /** sha256 of `content`, recorded against the run so a report names the script it measured. */
  sha256: string;
  /** Every path id the script exercises, in scenario order. */
  pathIds: string[];
}

export class EmptyIrError extends Error {}

export function generateK6Script(input: K6ScriptInput): GeneratedK6Script;
```

The emitted script has this shape. The `path_id` tag on every request and threshold is the contract
with the metrics join, so it is not optional and not derived from the URL:

```javascript
import http from 'k6/http';
import { check } from 'k6';

const DATA = JSON.parse(open('./data.json')); // generated alongside, from the seed

export const options = {
  discardResponseBodies: false,
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [{ target: 50, duration: '60s' }],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{path_id:get_order}': ['p(99)<250'], // from the IR SLO block
  },
};

export default function () {
  const row = DATA.orders[Math.floor(Math.random() * DATA.orders.length)];
  const res = http.get(`${__ENV.BASE_URL}/orders/${row.orderId}`, {
    tags: { path_id: 'get_order' },
  });
  check(res, { 'status is expected': (r) => r.status === 200 });
}
```

```
GET /experiments/:id/loadtest/script -> 200 text/javascript | 404
```

The endpoint returns the script the runner would execute, so a user can read it before spending money
on a run. It reads the experiment for the calling user only; another user's id reads as 404 rather
than 403, matching the repository's existing behaviour for repositories.

### Files

- CREATE `packages/core/src/loadtest/request-paths.ts`
- CREATE `packages/core/src/loadtest/k6-script.ts`
- CREATE `packages/core/src/loadtest/data-generator.ts` - seeded payload and parameter values
- CREATE `packages/core/src/loadtest/request-paths.test.ts`
- CREATE `packages/core/src/loadtest/k6-script.test.ts`
- CREATE `apps/api/src/routes/experiments/loadtest-script.ts`
- MODIFY `packages/core/src/index.ts` - export the load-test module

### Acceptance Criteria

- [ ] The same IR and seed produce byte-identical script content
- [ ] Every request path in the IR appears in the script tagged with its IR id
- [ ] A path parameter such as `/orders/:orderId` is substituted from generated data, never emitted literally
- [ ] A request path whose IR entry omits `weight` receives an equal share rather than being dropped
- [ ] An IR with no request paths raises `EmptyIrError` rather than producing a script that measures nothing
- [ ] Thresholds are derived from the IR SLO block, so k6 exits non-zero when the SLO is missed
- [ ] A path or field name containing a backtick or `${` is escaped, and the generated script still parses
- [ ] The generated script parses under `k6 inspect` with no syntax error
- [ ] The script endpoint returns 404 for an experiment belonging to another user

### Required Tests

- `is deterministic: the same ir and seed produce identical bytes`
- `tags every request with the ir path id`
- `substitutes path parameters from the generated data set`
- `gives every path an equal share when the ir omits weights`
- `rejects an ir with no request paths`
- `derives thresholds from the ir slo block`
- `escapes a path containing a template literal delimiter`
- `parses under k6 inspect, skipping when the k6 binary is absent`
- `does not return a script for another user's experiment`

### Performance Budget

`generateK6Script` for an IR with 50 request paths completes in under 50 ms, measured by the vitest
case. Generated `script.js` and `data.json` together stay under 256 KB, because the runner uploads
them to object storage rather than passing them in an ECS task override, where the 8 KB override
limit would truncate them.

### Out of Scope

- Do not run k6 or create any AWS resource; the runner is `docs/issues/epic-10-loadtest/020-fargate-spot-runner.md`
- Do not parse OpenAPI documents or source files to discover routes; the IR is the only input
- Do not implement authenticated request flows; record an unauthenticated-only note in the script header and leave login token minting to a later issue
- Do not touch `apps/web/src/lib/gitops/workflow-generator.ts`; it generates deployment workflows, not tests
- Do not add a second IaC-style template engine; the script is emitted from typed builders

### Dependencies

Blocked by #27, and by the IR schema in `docs/issues/epic-2-ir/010-architecture-ir-schema.md`.

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm --filter @infracanvas/api test:integration
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
