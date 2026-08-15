---
title: '[api] A signed token cannot outlive the session it was issued for'
labels: tier:1, size:s, area:api, epic:1-data
---

### Epic

#2

### Context

`sessionIsLive` in `apps/api/src/middleware/auth.ts` decides, on every authenticated request, whether
the session behind a JWT is still valid. Its first statement is:

```typescript
async function sessionIsLive(payload: SessionPayload): Promise<boolean> {
  if (!payload.sessionId) return true;
```

A token carrying no `sessionId` claim skips the lookup and is trusted on its signature alone. Its
docstring explains why: _"Tokens with no `sessionId` predate the sessions table and are trusted on
their signature alone, so an existing sign-in is not invalidated by a deploy."_ That was a reasonable
compatibility shim on the day the `sessions` table landed.

It is no longer reachable by any legitimate token, and it can be shown rather than assumed.
`db/migrations/20260810130000_sessions.sql` created the table, every token issued since carries a
`sessionId`, and `apps/api/src/lib/jwt.ts` sets a one-hour token lifetime. Any token minted before
that migration expired within an hour of it. There is no live token this branch is protecting.

What it does instead is remove the property the lookup exists to provide. The surrounding docstring
states it plainly: _"A signature cannot be withdrawn, so without this lookup logging out would merely
stop the browser from sending the cookie: anyone holding a copy would keep access until the token
expired on its own."_ For a token without `sessionId`, that is exactly what happens — sign-out writes
`revoked_at` on a row nothing consults.

This is not a forgery path. Minting such a token requires `JWT_SECRET`, so an attacker who can build
one can already build a valid session token. The consequences are narrower and still worth closing:
sign-out does not revoke a leaked copy, and a compromised `JWT_SECRET` yields tokens that cannot be
revoked even after rotation, because revocation is per session and these have no session.

The fix is to delete the branch, so a token with no `sessionId` fails the check like any token naming
a session that is not live. That is also the correct behaviour for the tenancy work in Phase 1: once
a request resolves a workspace, a session row is where that resolution is anchored, and a token
without one cannot be scoped to anything.

Spec: `docs/issues/epic-1-data/130-auth-choice-and-durable-sessions.md`

### Contract

```typescript
// apps/api/src/middleware/auth.ts
//
// Every authenticated request resolves its session row. A token naming no
// session names nothing that can be revoked, so it is refused rather than
// trusted on its signature.
async function sessionIsLive(payload: SessionPayload): Promise<boolean>;
```

Behaviour:

| `payload.sessionId` | `sessions` row               | Result                           |
| ------------------- | ---------------------------- | -------------------------------- |
| absent              | —                            | `false`                          |
| present             | live                         | `true`                           |
| present             | revoked, expired, or missing | `false`                          |
| present             | lookup throws                | `false`, and the error is logged |

The database-outage case is unchanged and deliberate: it already fails closed, and the existing
comment — _"A database outage should not silently turn into an open door"_ — is the reason.

### Files

- `apps/api/src/middleware/auth.ts` — MODIFY: remove the `if (!payload.sessionId) return true;`
  branch and the docstring paragraph that justified it; state that a token without a session is
  refused.
- `apps/api/src/middleware/auth.test.ts` — MODIFY: add the cases below.

### Acceptance Criteria

- [ ] A validly signed token with no `sessionId` claim is rejected with 401.
- [ ] A validly signed token naming a live session is accepted, unchanged.
- [ ] A validly signed token naming a revoked session is rejected, unchanged.
- [ ] Signing out and replaying the captured cookie is rejected, for every token shape.
- [ ] A database outage during the lookup still fails closed and logs.
- [ ] `optionalAuth` treats a token with no `sessionId` as absent rather than as a valid caller.

### Required Tests

- `refuses a signed token that names no session` — mints a token with `JWT_SECRET` and no `sessionId`,
  presents it to a `requireAuth` route, expects 401. Must fail against the current implementation.
- `refuses a signed token whose session was revoked` — the existing guarantee, asserted alongside so a
  future change cannot trade one for the other.
- `accepts a signed token naming a live session` — the ordinary path still works.
- `optionalAuth does not populate a session for a token that names none` — the anonymous branch is
  taken rather than a half-populated request reaching a handler.
- `fails closed when the session lookup throws` — a repository stub that rejects yields 401 and logs.

### Performance Budget

Every authenticated request already performs this primary-key lookup whenever `sessionId` is present,
which is all of them. Removing a branch that skipped it for tokens that no longer exist changes no
measured path. `docs/DELIVERY.md` budgets API p99 under 100 ms on non-AI routes and that must hold.

### Out of Scope

- Cookie attributes. `apps/api/src/lib/auth/cookie.ts` sets `sameSite: 'lax'`, which does not survive
  a cross-site deployment; that is its own tier-1 issue and must ship with CSRF defence rather than
  alone.
- Token lifetime, refresh, or the sliding-expiry rewrite.
- Rotating `JWT_SECRET`, or key versioning.
- Any change to `establishSession` or either sign-in method.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/api exec vitest run src/middleware/auth.test.ts
pnpm --filter @infracanvas/api exec tsc --noEmit
```

Then demonstrate the property end to end against a running API: sign in, capture the cookie, sign out,
and replay it. The replay must return 401.

```bash
pnpm db:up && pnpm db:migrate && pnpm dev
```
