---
title: '[api] Pluggable GitHub auth so local and self-host do not need an OAuth app'
labels: tier:1, size:m, area:api, epic:1-data
---

### Epic

#2

### Context

Running InfraCanvas today requires registering a GitHub OAuth application first. `env.ts` refuses to
start without `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, so a contributor who clones the
repository cannot reach a working app, and neither can anyone self-hosting it. For a project whose
whole premise is "point it at your repository", that is the first thing a new user hits and the most
likely place they give up.

The hosted product still needs OAuth. It is multi-user: `users` and `github_tokens` are keyed per
account, and each `/github/*` route reads the requesting user's own token. Nothing about that
changes.

What changes is where the token comes from. OAuth is one way to obtain a GitHub token; a personal
access token in the environment, or the one `gh` already holds in the OS keyring, are others. Once
acquired, every downstream path is identical: identify the account, upsert the user, encrypt and
store the token, issue the same session cookie.

**This is a tier 1 change.** The token provider authenticates whoever asks, as the operator, with
`repo` scope. On a laptop that is exactly what is wanted. Exposed to a network it is an open door to
every repository the operator can reach, so the provider must refuse non-loopback callers unless the
operator explicitly opts in.

Spec: `docs/DATABASE.md`, `apps/api/.env.example`

### Contract

```ts
// apps/api/src/lib/auth/token-source.ts
export type TokenOrigin = 'env' | 'gh-cli';
export interface ResolvedToken {
  token: string;
  origin: TokenOrigin;
}
/** GITHUB_TOKEN first, then `gh auth token`. Null when neither yields one. */
export function resolveGitHubToken(): Promise<ResolvedToken | null>;

// apps/api/src/lib/auth/session.ts
/** Identify the account, upsert the user, store the token, set the session cookie. */
export function establishSession(
  res: Response,
  credentials: { accessToken: string; tokenType: string; scope: string }
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

`AUTH_PROVIDER` is `oauth` or `token`, defaulting to `oauth`. `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` are required only when the provider is `oauth`.

`GET /auth/github` redirects to GitHub under `oauth`, and under `token` resolves a token, establishes
a session, and redirects to `${APP_URL}/callback?success=true` - the same destination the OAuth
callback uses, so the web app needs no change.

### Files

- CREATE `apps/api/src/lib/auth/token-source.ts`
- CREATE `apps/api/src/lib/auth/session.ts`
- CREATE `apps/api/src/lib/auth/token-source.test.ts`
- CREATE `apps/api/src/lib/auth/session.test.ts`
- MODIFY `apps/api/src/lib/env.ts` - add `AUTH_PROVIDER`, make OAuth credentials conditional
- MODIFY `apps/api/src/routes/auth/github.ts` - branch on the provider, guard non-loopback callers
- MODIFY `apps/api/src/routes/auth/callback.ts` - use the shared `establishSession`
- MODIFY `apps/api/.env.example` - document both providers
- MODIFY `README.md` - local setup without an OAuth app

### Acceptance Criteria

- [ ] The API starts with no `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` when `AUTH_PROVIDER=token`
- [ ] The API still refuses to start without them when `AUTH_PROVIDER=oauth`
- [ ] `GET /auth/github` under `token` returns a working session for the `gh` account
- [ ] `GITHUB_TOKEN` takes precedence over `gh auth token`
- [ ] A non-loopback request to `GET /auth/github` under `token` is refused with 403 unless
      `AUTH_TOKEN_ALLOW_REMOTE=true`
- [ ] The resolved token is never written to a log, an error body, or a response header
- [ ] The OAuth flow is byte-for-byte unchanged in behaviour, including CSRF state verification
- [ ] `gh` is invoked without a shell, so no argument can be interpreted as a command
- [ ] A missing or logged-out `gh` produces an actionable error rather than a stack trace

### Required Tests

- `env token is preferred over the gh cli`
- `falls back to the gh cli when no env token is set`
- `returns null when neither source yields a token`
- `a gh failure is reported without leaking stderr into the response`
- `oauth provider still requires client credentials`
- `token provider does not require client credentials`
- `a non-loopback request is refused under the token provider`
- `a non-loopback request is allowed when the operator opts in`
- `the resolved token never appears in any log call`

### Performance Budget

`GET /auth/github` under the token provider completes in under 2 seconds, dominated by the GitHub
`/user` call. The `gh` invocation is capped at 5 seconds so a stuck keyring prompt cannot hang a
request indefinitely.

### Out of Scope

- Do not change the `users` or `github_tokens` schema; the token path reuses both as they are
- Do not change any `/github/*` route; they read the stored token and cannot tell the providers apart
- Do not add a UI for pasting a personal access token; that is a separate decision
- Do not remove or weaken the OAuth CSRF state check

### Dependencies

none

### Verification

```bash
AUTH_PROVIDER=token pnpm --filter @infracanvas/api dev
curl -i http://localhost:3001/auth/github
curl -s http://localhost:3001/auth/status
pnpm --filter @infracanvas/api test
```

### Risk Tier

tier:1 - authentication and credentials

### Size

size:m - 200 to 600 lines
