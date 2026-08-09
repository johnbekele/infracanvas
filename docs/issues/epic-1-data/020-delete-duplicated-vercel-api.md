---
title: '[api] Delete the duplicated Vercel serverless API'
labels: tier:1, size:s, area:api, epic:1-data
---

### Epic

#2

### Context

There are two implementations of the same API. `apps/api` is an Express server deployed to Render;
`apps/web/api` is a set of Vercel serverless functions that reimplements the same routes with copied
helpers for auth, JWT, encryption, and environment handling.

The cost of this is not theoretical. When the SSRF vulnerability in the GitHub proxy routes was
fixed, the fix had to be written twice, and a validator file was duplicated to make that possible.
Every future change to authentication or the GitHub proxy carries the same tax, and any fix applied
to one copy and forgotten in the other is a security hole that looks closed.

The duplicate is also the last thing in the repository still importing MongoDB, so it blocks the
removal of that dependency.

`apps/web/src/lib/api/client.ts` already reads `VITE_API_URL` and falls back to relative URLs, so
the frontend talks to Render as soon as that variable is set.

### Contract

No new interfaces. `apps/web/api` is removed in its entirety and `vercel.json` no longer declares
any functions:

```typescript
// apps/web/src/lib/api/client.ts is unchanged; it already resolves:
const API_BASE_URL = import.meta.env.VITE_API_URL || '';
```

Every route removed here has an existing equivalent under `apps/api/src/routes`, which must be
confirmed route by route before deletion:

| Removed                             | Replacement                            |
| ----------------------------------- | -------------------------------------- |
| `apps/web/api/auth/github.ts`       | `apps/api/src/routes/auth/github.ts`   |
| `apps/web/api/auth/github/callback` | `apps/api/src/routes/auth/callback.ts` |
| `apps/web/api/auth/logout.ts`       | `apps/api/src/routes/auth/logout.ts`   |
| `apps/web/api/auth/status.ts`       | `apps/api/src/routes/auth/status.ts`   |
| `apps/web/api/github/*`             | `apps/api/src/routes/github/*`         |

### Files

- DELETE `apps/web/api/` (all 15 files, including `_lib/`)
- MODIFY `vercel.json` - remove the `functions` block and the `/api/:path*` rewrite
- MODIFY `apps/web/package.json` - remove `mongodb` and `@vercel/node`
- MODIFY `docs/DEPLOYMENT.md` - state that the frontend requires `VITE_API_URL`

### Acceptance Criteria

- [ ] `apps/web/api` no longer exists
- [ ] No file in the repository imports `mongodb`
- [ ] `vercel.json` declares no serverless functions
- [ ] Every route listed in the contract table has a verified equivalent in `apps/api`
- [ ] The web build succeeds and the deployed bundle calls the absolute `VITE_API_URL` origin
- [ ] Documentation states that `VITE_API_URL` is required, not optional

### Required Tests

- `builds without the removed api directory` - `pnpm turbo build --filter=@infracanvas/web` succeeds
- `no source file imports mongodb` - a grep assertion in CI, since there is no unit under test here
- Manual: sign in end to end against the Render API with `VITE_API_URL` set, confirming the OAuth
  callback sets a session cookie and `/auth/status` returns `authenticated: true`

### Performance Budget

n/a

### Out of Scope

- Do not change any route behaviour in `apps/api`; this is a deletion, and any difference found
  between the two copies must be reported on this issue rather than silently reconciled
- Do not remove `apps/api/src/lib/github-params.ts`, which is the surviving copy
- Do not alter the Vercel build or output configuration beyond removing the functions block

### Dependencies

Blocked by #22. `VITE_API_URL` must be set on the Vercel project before this merges, otherwise the
deployed frontend loses its backend.

### Verification

```bash
test ! -d apps/web/api
! grep -rn "from 'mongodb'" apps/ packages/ --include='*.ts'
pnpm install
pnpm turbo build typecheck test
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:s - under 200 lines
