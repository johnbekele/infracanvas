---
title: '[web] Branch listing and creation address the route the server registers'
labels: tier:2, size:s, area:web, epic:11-ui
---

### Epic

#12

### Context

Branch listing and branch creation in the push-to-GitHub flow are dead. Neither has ever worked.

`apps/web/src/lib/api/client.ts` builds both requests with query parameters:

```typescript
apiFetch(`/github/branches?owner=${owner}&repo=${repo}`);
```

`apps/api/src/routes/github/branches.ts` registers both handlers with path parameters, mounted at
`/branches` by `apps/api/src/routes/github/index.ts`:

```typescript
router.get('/:owner/:repo', requireAuth, ...);
router.post('/:owner/:repo', requireAuth, ...);
```

A request to `/github/branches` with no path segments matches neither route, falls through the
router, and lands on the global 404 handler in `apps/api/src/index.ts`. The callers are
`PushToGitHubDialog.tsx` at `listBranches` and `createBranch`, so a user who opens the push dialog
cannot see the branches on their repository and cannot create one.

The fix belongs on the client. The server's form is the correct one: it reads `req.params` through
`assertRepoCoordinates` from `apps/api/src/lib/github-params.ts`, which exists because these routes
proxy to GitHub carrying the user's bearer token and an owner of `../../user` would exfiltrate it.
Moving the server to query parameters would mean a second validation path for the same values, which
is how one of them ends up missing a check.

The client also interpolates `owner` and `repo` into the URL unencoded. Both are validated
server-side, so this is not the security boundary, but a repository name containing a character that
is legal in a path segment and meaningful in a URL produces a request that fails confusingly rather
than cleanly.

Neither unit suite can see this class of defect: the server's routes are tested against the router
that registers them, and the client is tested against a stubbed `fetch`. Both are individually
correct and the pair does not compose. So this issue adds the check that would have caught it —
asserting every path the client builds resolves against the router the server mounts — rather than
only correcting two template literals.

Spec: `docs/issues/epic-11-web/010-connect-and-analyse-a-repository.md`

### Contract

```typescript
// apps/web/src/lib/api/client.ts
async listBranches(owner: string, repo: string): Promise<
  Array<{ name: string; commit: { sha: string }; protected: boolean }>
>;
async createBranch(
  owner: string,
  repo: string,
  branchName: string,
  fromBranch: string
): Promise<unknown>;
```

Both address
`/github/branches/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`.

The request bodies are unchanged: `createBranch` continues to post
`{ branchName, fromBranch }`, which is what the handler requires before it calls `assertBranch` on
each.

### Files

- `apps/web/src/lib/api/client.ts` — MODIFY: address both branch endpoints by path segment, with each
  segment percent-encoded.
- `apps/web/src/lib/api/client.test.ts` — CREATE: the route-agreement test below.

### Acceptance Criteria

- [ ] `listBranches` issues a GET to `/github/branches/{owner}/{repo}`.
- [ ] `createBranch` issues a POST to `/github/branches/{owner}/{repo}` carrying `branchName` and `fromBranch`.
- [ ] Owner and repository segments are percent-encoded.
- [ ] A test fails if a client path stops matching a route the API router registers.
- [ ] Opening the push dialog against a real repository lists its branches.

### Required Tests

- `listBranches requests the path the server registers` — captures the URL passed to a stubbed
  `fetch` and asserts it is `/github/branches/acme/widgets`, with no query string.
- `createBranch posts to the path the server registers` — asserts the method, the URL and the body.
- `encodes each path segment` — an owner or repository name containing a character that must be
  escaped produces an escaped segment rather than a second path separator.
- `every client path matches a route the API registers` — enumerates the paths `client.ts` builds and
  asserts each resolves against the Express router assembled by `apps/api/src/routes`, so the two
  halves cannot drift apart again. This is the case that would have caught the defect.

### Performance Budget

n/a

### Out of Scope

- Pagination for `GET /github/repos`, which caps at `per_page=100` with no follow-on request and
  silently truncates for a user with more than 100 repositories. Real, separate, and not on this path.
- Any change to the server routes, their validation, or `github-params.ts`.
- The push flow's behaviour once branches load.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/web exec vitest run src/lib/api/client.test.ts
pnpm --filter @infracanvas/web exec tsc --noEmit
```

End to end, against a running stack, the dialog must list real branches rather than report an error:

```bash
pnpm db:up && pnpm db:migrate && pnpm dev
```
