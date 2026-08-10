---
title: '[api] Replace the hand-rolled rate limiter with a maintained one'
labels: tier:2, size:s, area:api, epic:0-delivery
---

### Epic

#1

### Context

`apps/api/src/middleware/rate-limit.ts` counts requests in a `Map` keyed by `req.ip`, with a global
`setInterval` sweeping expired entries once a minute. Its own header comment says it is not what
should run in production.

Counting requests looks trivial and is not. IPv6 clients are allocated a /64 each, so keying on the
full address lets one host rotate through addresses indefinitely and never reach a limit. The
`RateLimit` headers are a specified format rather than something to invent; the current code emits
the older `X-RateLimit-*` set. A store swept only on a timer keeps every key seen since the last
sweep resident, and the interval keeps the process alive.

There is a second, quieter problem. The key falls back to `req.ip || X-Forwarded-For`, but the app
never sets `trust proxy`, so `req.ip` is the socket address. Behind a proxy that puts every caller in
one bucket keyed by the proxy, and the first noisy client locks out everyone else. Whether that
header can be believed is a deployment fact and has to be stated, not guessed.

CodeQL does not recognise the hand-rolled middleware as rate limiting either, which is why
`js/missing-rate-limiting` has seven open alerts against routes that are in fact limited. Every new
route adds another, so the noise grows with the codebase and eventually hides a real finding.

### Contract

```typescript
/** Reverse proxy hops in front of this process. Default 0: never believe a forwarded header. */
export const TRUST_PROXY_HOPS: number;

export const authRateLimit: RequestHandler; // 20 per 15 minutes
export const apiRateLimit: RequestHandler; // 100 per minute
```

Both are built with `express-rate-limit`. The exported names do not change, so no route changes.

### Files

- MODIFY `apps/api/src/middleware/rate-limit.ts`
- MODIFY `apps/api/src/index.ts` (set `trust proxy` from `TRUST_PROXY_HOPS`)
- MODIFY `apps/api/.env.example`, `render.yaml`
- CREATE `apps/api/src/middleware/rate-limit.test.ts`

### Acceptance Criteria

- [ ] Requests under the limit are served
- [ ] The first request past the limit is answered 429 with `{ "error": "Too many requests" }`
- [ ] A 429 carries `Retry-After`
- [ ] The standard `RateLimit` headers are sent and the legacy `X-RateLimit-*` ones are not
- [ ] `authRateLimit` is tighter than `apiRateLimit`
- [ ] With no proxy trusted, varying `X-Forwarded-For` does not earn a fresh bucket
- [ ] `TRUST_PROXY_HOPS` defaults to 0 and is documented in `.env.example` and `render.yaml`
- [ ] `js/missing-rate-limiting` reports no alert against a limited route

### Required Tests

- `allows traffic under the limit`
- `answers 429 once the window limit is passed`
- `tells the caller when to retry`
- `advertises the policy in the standard headers rather than the legacy ones`
- `is tighter than the general API limit`
- `cannot be chosen by the caller when no proxy is trusted`

### Performance Budget

n/a

### Out of Scope

- A shared store. The limit stays per-process, so it multiplies by instance count once this runs on
  more than one. That is a real limitation and is its own issue; with this change it becomes a store
  option rather than a rewrite.
- Per-user or per-route limits beyond the two that exist.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/api test
pnpm lint && pnpm typecheck
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
