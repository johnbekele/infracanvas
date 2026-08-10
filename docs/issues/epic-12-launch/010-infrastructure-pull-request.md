---
title: '[api] Open an infrastructure pull request in the target repository'
labels: tier:1, size:m, area:api, epic:12-launch
---

### Epic

#13

### Context

The generated infrastructure has to arrive in the user's repository the way a colleague's work arrives:
as a pull request that can be read, argued with, and reverted. Today it arrives as a commit. The push
dialog defaults its branch to the repository's default branch, and `apps/api/src/routes/github/push.ts`
updates that ref directly, so the common path writes Terraform that provisions billable resources
straight onto `main` with nothing between generation and merge. For output that spends money, an
unreviewed commit on the default branch is the wrong default.

This extends the existing push path rather than replacing it. The sequence in `push.ts` is already the
correct one -- create blobs, build a tree on the base tree, create one commit, move the ref once -- so
files land atomically instead of arriving one commit at a time; and `apps/api/src/lib/github-params.ts`
is already the tested validation surface for owner, repository, and branch names. What is missing is
creating the head branch from a known base, opening the pull request, and refusing to write to the
branch the user deploys from. Those are added; the existing endpoint and its response shape stay, because
the dialog depends on them and a direct push is still the right tool for a repository the user owns
outright.

Two alternatives were rejected. Shelling out to `git` with a temporary clone needs a writable working
copy per request, puts the user's token in a credential helper on disk, and is slower than the four API
calls it replaces. GitHub's contents endpoint, one call per file, produces one commit per file and
rewrites files it was not asked to touch; neither is acceptable for generated infrastructure.

"Applies cleanly" is made checkable by pinning the base. The base SHA is read when the files are
generated and sent with the request; the ref update is not forced, so GitHub itself refuses the write
when the base has moved, and the user regenerates instead of silently clobbering a colleague's commit.
"Passes the target repository CI" is made checkable by never colliding: a workflow named `terraform.yml`
is a name a real repository plausibly already uses, so generated workflows are named
`infracanvas-<iac>.yml`, and any path already present in the base tree is skipped and listed in the pull
request body rather than overwritten.

### Contract

```typescript
// apps/api/src/lib/github/commit.ts -- extracted from routes/github/push.ts unchanged
export interface PushFile {
  path: string;
  content: string;
}

export interface CommitTreeInput {
  token: string;
  owner: string;
  repo: string;
  baseSha: string;
  message: string;
  files: readonly PushFile[];
}

/** Blobs, tree on `baseSha`, one commit. Does not move any ref. */
export function commitTree(input: CommitTreeInput): Promise<{ commitSha: string }>;
```

```typescript
// apps/api/src/lib/github/pull-request.ts
export interface OpenPullRequestInput {
  token: string;
  owner: string;
  repo: string;
  /** Defaults to the repository's default branch, read from the API. */
  base: string;
  /** `infracanvas/<experiment-slug>-<short-sha>`. */
  head: string;
  /** Tip of `base` when the files were generated. A moved base is refused, never forced. */
  baseSha: string;
  title: string;
  body: string;
  files: readonly PushFile[];
}

export interface OpenedPullRequest {
  pullRequestUrl: string;
  pullRequestNumber: number;
  branch: string;
  headSha: string;
  written: string[];
  /** Paths already present in the base tree, skipped rather than overwritten. */
  skipped: string[];
  reused: boolean;
}

export class BaseMovedError extends Error {} // -> 409
export class ProtectedHeadError extends Error {} // -> 400

export function openPullRequest(input: OpenPullRequestInput): Promise<OpenedPullRequest>;

/** `infra/**` plus `.github/workflows/infracanvas-<iac>.yml` plus `infra/README.md`. */
export function buildInfraTree(experimentId: string): Promise<PushFile[]>;
```

```
POST /github/pull-request
  { experimentId, owner, repo, base?, title?, body? }
  -> 201 { pullRequestUrl, pullRequestNumber, branch, headSha, written, skipped, reused }
  -> 400 when the requested head is the base or the default branch
  -> 409 when the base branch moved since generation
  -> 422 relayed from GitHub when the repository is not writable
```

Calling it twice for one experiment updates the existing head branch and returns the open pull request
with `reused: true`, rather than opening a second one.

The body is generated, not free text: the resource summary, the predicted monthly cost, the secrets the
workflow needs, the list of skipped paths, and a link to `infra/README.md`. It never contains a token,
a presigned URL, or an AWS account id.

### Files

- CREATE `apps/api/src/lib/github/commit.ts`
- CREATE `apps/api/src/lib/github/pull-request.ts`
- CREATE `apps/api/src/lib/github/pull-request-body.ts`
- CREATE `apps/api/src/routes/github/pull-request.ts`
- CREATE `apps/api/src/lib/github/pull-request.test.ts`
- CREATE `apps/api/src/routes/github/pull-request.integration.test.ts`
- MODIFY `apps/api/src/routes/github/push.ts` - call `commitTree`, keeping its request and response shape
- MODIFY `apps/api/src/routes/github/index.ts` - mount `/pull-request`
- MODIFY `apps/web/src/lib/gitops/workflow-generator.ts` - emit `infracanvas-terraform.yml` and `infracanvas-pulumi.yml`
- MODIFY `apps/web/src/components/github/PushToGitHubDialog.tsx` - open a pull request by default, direct push still available

### Acceptance Criteria

- [ ] The pull request targets the repository's default branch, read from the GitHub API rather than the request body
- [ ] The head branch is created from the `baseSha` supplied with the request
- [ ] A request whose `baseSha` is no longer the tip of the base is refused with 409 and creates no branch
- [ ] A request whose head equals the base or the default branch is refused with 400
- [ ] A path already present in the base tree is skipped, listed in `skipped`, and named in the pull request body
- [ ] Generated workflows are written as `infracanvas-<iac>.yml`, so they cannot collide with an existing `terraform.yml`
- [ ] The pull request body lists the required secrets and the predicted monthly cost
- [ ] A second request for the same experiment updates the existing branch and returns `reused: true`
- [ ] The GitHub token appears in no response body, no log line, and no pull request body
- [ ] The existing `POST /github/push` request and response shape is unchanged
- [ ] Against a fixture repository, the opened pull request reports mergeable and its checks conclude successfully

### Required Tests

- `creates the head branch from the base sha it was given`
- `refuses with a conflict when the base branch has moved`
- `refuses a head branch that is the default branch`
- `skips a path that already exists in the base tree and names it in the body`
- `reuses the open pull request when asked twice for the same experiment`
- `keeps the existing push endpoint response shape`
- `omits the github token from responses and log lines`
- `relays the github status code when the repository is not writable`
- `opens a pull request on the fixture repository that is mergeable with successful checks`

### Performance Budget

A pull request carrying 20 generated files completes in under 6 seconds against the live GitHub API at
p95, using at most 26 API requests: blobs are created concurrently, and the count is asserted in the
unit test by counting stubbed `fetch` calls.

### Out of Scope

- Do not change the validation rules in `apps/api/src/lib/github-params.ts`; reuse them as they are
- Do not remove `POST /github/push` or alter its response shape
- Do not implement the application patches; they are `docs/issues/epic-12-launch/020-application-refactor-patches.md`
- Do not add a GitHub App installation flow; token resolution stays as `docs/issues/epic-1-data/120-pluggable-github-auth.md` defines it
- Do not enable auto-merge, a merge queue, or branch protection on the user's repository
- Do not change the Terraform or Pulumi generators in `packages/core/src/codegen/`; only the workflow file name changes

### Dependencies

Blocked by #27, and by the code generation output of Epic 8 (#9).

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test:integration
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
gh pr view "$PR_URL" --json mergeable,mergeStateStatus,files
gh pr checks "$PR_URL"
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
