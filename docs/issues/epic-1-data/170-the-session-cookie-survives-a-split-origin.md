---
title: '[api] Make the session cookie work across origins, with CSRF defence in the same change'
labels: tier:1, size:m, area:api, epic:1-data
---

### Epic

#2

### Context

The deployed application is served from two registrable domains. `README.md` documents the shape: the
frontend is a static bundle on Vercel, the API is an Express service on Render, and `VITE_API_URL`
points one at the other. `apps/web/src/lib/api/client.ts` sends every request with
`credentials: 'include'` and has no token fallback, so the session cookie is the only credential.

`apps/api/src/lib/auth/cookie.ts` sets that cookie with `sameSite: 'lax'`.

A `Lax` cookie is sent on top-level navigation and withheld from cross-site subresource requests,
which is what an `XMLHttpRequest` or `fetch` from `app.vercel.app` to `api.onrender.com` is. So on the
hosted deployment the browser holds a session cookie and declines to send it, and every authenticated
call returns 401. Local development is unaffected — Vite proxies `/api` to `localhost:3001`, making
the request same-site — which is exactly why this survives: the failure appears only where nobody is
running a debugger.

The fix is `SameSite=None; Secure`. That is also the reason this issue is larger than a one-word
change: `SameSite=Lax` is, today, the only thing standing between this API and cross-site request
forgery. Every state-changing route — `POST /repositories`, `DELETE /repositories/:id`,
`POST /github/push`, `POST /settings/llm`, `POST /auth/logout` — is a cookie-authenticated endpoint
with no CSRF token. Shipping `SameSite=None` without a replacement defence would take a real
protection away and put nothing back, so the two must land together. Splitting them across two pull
requests leaves a window in which the application is worse than it is now.

The defence is double-submit with a signed token, rather than a server-side synchroniser token,
because the API is stateless per request beyond the session row and the alternative would add a
per-session store to protect against an attack the token already prevents. The token is bound to the
session id, so a token minted for one session cannot authorise a request carrying another.

`Origin` checking alone was considered and rejected as the primary defence. It is a good second layer
and is included, but browsers omit `Origin` on some same-origin requests and a policy that fails
closed on a missing header breaks those, while one that fails open is not a defence.

Spec: `docs/issues/epic-1-data/130-auth-choice-and-durable-sessions.md`

### Contract

```typescript
// apps/api/src/lib/auth/cookie.ts
//
// SameSite=None because the browser app and this API are different registrable
// domains in every deployment except local development, and a Lax cookie is
// withheld from exactly the cross-site fetch the app makes. None requires
// Secure, so the cookie is https-only outside development.
export const SESSION_COOKIE: string;
export const CSRF_COOKIE: string;

export function sessionCookieOptions(): CookieOptions;
/** Readable by script: the client must echo it in a header. */
export function csrfCookieOptions(): CookieOptions;
```

```typescript
// apps/api/src/lib/auth/csrf.ts

/** HMAC over the session id with JWT_SECRET, base64url. Bound to the session so
 *  a token from one session cannot authorise a request in another. */
export function mintCsrfToken(sessionId: string): string;

/** Constant-time comparison. Returns false rather than throwing on any
 *  malformed input, because a thrown error here becomes a 500 on a request that
 *  should be a 403. */
export function csrfTokenMatches(sessionId: string, presented: string): boolean;
```

```typescript
// apps/api/src/middleware/csrf.ts
//
// Refuses a state-changing request whose CSRF header does not match the cookie.
// Safe methods pass untouched: a GET that changes state is a defect this
// middleware cannot fix and must not pretend to.
export function requireCsrf(req: Request, res: Response, next: NextFunction): void;
```

Behaviour:

| Method                   | Header present and valid | `Origin`                | Result                   |
| ------------------------ | ------------------------ | ----------------------- | ------------------------ |
| GET, HEAD, OPTIONS       | —                        | —                       | pass                     |
| POST, PUT, PATCH, DELETE | yes                      | allowed or absent       | pass                     |
| POST, PUT, PATCH, DELETE | no                       | —                       | 403 `csrf_token_missing` |
| POST, PUT, PATCH, DELETE | invalid                  | —                       | 403 `csrf_token_invalid` |
| POST, PUT, PATCH, DELETE | yes                      | present and not allowed | 403 `origin_not_allowed` |

The header is `X-CSRF-Token`. The cookie carrying it is not `httpOnly` — it must be readable by the
client to be echoed — and that is safe because possession of the cookie is not the check; matching it
against an HMAC the server can recompute is.

`apps/web/src/lib/api/client.ts` reads the cookie and sets the header on every non-safe request.

### Files

- `apps/api/src/lib/auth/cookie.ts` — MODIFY: `sameSite: 'none'` with `secure: true` outside
  development; add the CSRF cookie's options.
- `apps/api/src/lib/auth/csrf.ts` — CREATE: mint and verify.
- `apps/api/src/middleware/csrf.ts` — CREATE: the middleware above.
- `apps/api/src/index.ts` — MODIFY: mount `requireCsrf` after the body parser and before the routes.
- `apps/api/src/lib/auth/session.ts` — MODIFY: set the CSRF cookie whenever the session cookie is set,
  including on refresh, so a rotated session never leaves a stale token.
- `apps/api/src/middleware/cors.ts` — MODIFY: allow `X-CSRF-Token` in `Access-Control-Allow-Headers`.
- `apps/web/src/lib/api/client.ts` — MODIFY: echo the cookie into the header on non-safe requests.
- `apps/api/src/lib/auth/csrf.test.ts` — CREATE: the token cases.
- `apps/api/src/middleware/csrf.test.ts` — CREATE: the middleware cases.

### Acceptance Criteria

- [ ] The session cookie is `SameSite=None; Secure` outside development, and `Lax` in development where the origin is shared.
- [ ] A state-changing request with no CSRF header is refused with 403.
- [ ] A state-changing request whose token was minted for a different session is refused with 403.
- [ ] A state-changing request with a valid token succeeds.
- [ ] Safe methods are never refused by this middleware.
- [ ] Signing in, refreshing and signing out all leave the CSRF cookie consistent with the session cookie.
- [ ] The browser application authenticates successfully against an API on a different registrable domain.
- [ ] No route bypasses the middleware except the auth callback, which has no session yet and is protected by its own state parameter.

### Required Tests

- `mints a token bound to the session` — two session ids yield different tokens, and a token verifies
  only against the session it was minted for.
- `rejects a malformed token without throwing` — empty string, wrong length and non-base64url input all
  return false rather than raising, so a hostile header cannot produce a 500.
- `compares in constant time` — asserts the comparison uses `timingSafeEqual` rather than `===`; a
  length-mismatched input must still be handled.
- `lets a safe method through` — GET with no header passes.
- `refuses a post with no header` — 403 and the `csrf_token_missing` code.
- `refuses a post whose token belongs to another session` — 403 and `csrf_token_invalid`. This is the
  case a naive double-submit implementation passes and is the reason the token is bound.
- `accepts a post with a valid token` — the ordinary path.
- `refuses a disallowed origin even with a valid token` — defence in depth, asserted so the layer
  cannot be dropped silently.
- `sets both cookies on sign-in and clears both on sign-out` — a session cookie without its CSRF
  companion would refuse every write, so the pairing is asserted rather than assumed.
- `the client echoes the cookie on a non-safe request` — in `apps/web`, a stubbed document cookie
  produces the header on POST and no header on GET.

### Performance Budget

The middleware performs one HMAC per state-changing request. `docs/DELIVERY.md` budgets API p99 under
100 ms on non-AI routes and that must hold; an HMAC over a uuid is microseconds.

### Out of Scope

- The session revocation bypass in `apps/api/src/middleware/auth.ts`, which is
  `150-a-signed-token-cannot-outlive-its-revocation.md` and independent.
- Moving to a bearer token in a header, which would remove the CSRF question entirely and is a larger
  change to how the browser stores credentials.
- `helmet` and the absent security headers, which deserve their own issue.
- Rotating `JWT_SECRET`, which this reuses as the HMAC key.
- Rate limiting.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/api exec vitest run src/lib/auth/csrf.test.ts src/middleware/csrf.test.ts
pnpm --filter @infracanvas/api exec vitest run
pnpm --filter @infracanvas/web exec vitest run src/lib/api
```

Then prove the cross-origin case, which is the one local development hides. Serve the built frontend
from a different origin to the API and confirm an authenticated write succeeds:

```bash
pnpm db:up && pnpm db:migrate
pnpm --filter @infracanvas/api dev &
pnpm --filter @infracanvas/web build
npx serve -l 4173 apps/web/dist   # VITE_API_URL must point at http://localhost:3001
```

Sign in, then confirm a write succeeds with the header and is refused without it:

```bash
curl -i -X POST localhost:3001/repositories -b cookies.txt -H 'Content-Type: application/json' -d '{}'
```

The request without `X-CSRF-Token` must return 403.
