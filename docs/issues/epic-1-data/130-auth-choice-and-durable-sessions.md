---
title: '[api] Let the user choose the sign-in method, and keep the session alive'
labels: tier:1, size:m, area:api, epic:1-data
---

### Epic

#2

### Context

`AUTH_PROVIDER` is read once at boot and memoised, so a deployment is permanently one thing. An
operator who registers a GitHub OAuth application and sets `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` while `AUTH_PROVIDER` is still `token` gets no error and no OAuth flow; the
credentials are simply never read. The two providers are not alternatives for a deployment, they are
alternatives for a sign-in, and the user is the one who knows which they want.

The local token provider has a second problem: it is silent about who it signed you in as. It
resolves `GITHUB_TOKEN`, falls back to `gh auth token`, and redirects to the same
`?success=true` callback OAuth uses. When the `gh` CLI is authenticated as a different account than
the one the operator expects, the only symptom is that repositories are missing, with nothing in the
interface connecting that to the token that was picked up.

Sessions are the third problem. The JWT lasts an hour, `requireAuth` computes a refreshed token and
sets it on an `X-Refreshed-Token` header, and nothing reads that header -- the cookie is never
rewritten, so the refresh path has never extended a session. Anyone analysing a large repository can
have the session expire underneath them.

Sessions stay in Postgres. A second embedded datastore alongside the pgvector instance the rest of
the system depends on would add a file to back up and a schema to migrate for no capability that
Postgres does not already have.

### Contract

```sql
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  -- The JWT carries this id; the row is what makes revocation possible.
  issued_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  auth_method text NOT NULL CHECK (auth_method IN ('oauth', 'token')),
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
```

```
GET  /auth/methods  -> { methods: [{ id, available, reason? }], default }
GET  /auth/github?method=oauth|token
GET  /auth/status   -> { authenticated, user?, hasGitHubToken?, authMethod?, tokenOrigin? }
POST /auth/logout   -> revokes the session row as well as clearing the cookie
```

```typescript
// apps/api/src/lib/auth/methods.ts
export interface AuthMethod {
  id: 'oauth' | 'token';
  available: boolean;
  /** Why it is unavailable, shown in the interface rather than logged. */
  reason?: string;
}
export function availableMethods(req: Request): Promise<AuthMethod[]>;
```

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` become optional at boot and are required at the moment
the OAuth route is used, so one process can offer both methods.

### Files

- CREATE `db/migrations/*_sessions.sql`
- CREATE `apps/api/src/lib/db/sessions.ts`
- CREATE `apps/api/src/lib/auth/methods.ts`
- CREATE `apps/api/src/lib/auth/methods.test.ts`
- CREATE `apps/api/src/routes/auth/methods.ts`
- MODIFY `apps/api/src/routes/auth/github.ts` -- select the method per request
- MODIFY `apps/api/src/lib/auth/session.ts` -- create a session row, record the method and origin
- MODIFY `apps/api/src/lib/env.ts` -- OAuth credentials optional at boot
- MODIFY `apps/api/src/middleware/auth.ts` -- rewrite the refreshed cookie, honour revocation
- MODIFY `apps/api/src/lib/jwt.ts` -- carry the session id
- CREATE `apps/web/src/components/auth/AuthMethodPicker.tsx`
- MODIFY `apps/web/src/components/auth/LoginButton.tsx`, `apps/web/src/lib/stores/auth-store.ts`

### Acceptance Criteria

- [ ] `GET /auth/methods` reports OAuth unavailable, with a reason, when no client id is configured
- [ ] `GET /auth/methods` reports the token method unavailable off loopback unless remote is allowed
- [ ] A request naming a method uses it, regardless of `AUTH_PROVIDER`
- [ ] A request naming no method uses `AUTH_PROVIDER`, preserving today's behaviour
- [ ] A request naming an unavailable method is refused with an explanation, not a redirect
- [ ] The API starts with no OAuth credentials configured and still serves the token method
- [ ] The status endpoint reports which method signed the user in and where the token came from
- [ ] A session used within its lifetime has its cookie rewritten and does not expire while in use
- [ ] Logging out revokes the session row, so its cookie stops working immediately
- [ ] A revoked session is rejected even though its JWT signature is still valid

### Required Tests

- `reports oauth as unavailable when no client id is configured`
- `reports the token method as unavailable for a remote caller`
- `uses the requested method rather than the configured default`
- `falls back to the configured provider when no method is requested`
- `refuses an unavailable method with a message rather than redirecting`
- `records the auth method and token origin on the session`
- `rewrites the session cookie when the token is close to expiry`
- `rejects a session that has been revoked`
- `rejects a session whose row has been deleted`

### Performance Budget

Session lookup adds at most one indexed query per authenticated request, under 2 ms locally. Sessions
are validated against the row only when the JWT is within its refresh window, so the common request
path stays signature-only.

### Out of Scope

- Sign-in providers other than GitHub
- Organisation or team-scoped permissions
- Rotating the encryption key for stored GitHub tokens
- Device management interface beyond revoking the current session

### Dependencies

Blocked by #45.

### Verification

```bash
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test
```

### Risk Tier

tier:1 - authentication and session handling

### Size

size:m - 200 to 600 lines
