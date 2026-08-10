---
title: '[api] Offer application refactor patches a user can take one at a time'
labels: tier:2, size:l, area:api, epic:12-launch
---

### Epic

#13

### Context

The generated infrastructure assumes four things about the application that are frequently untrue: that
it builds a container image, that it answers a health probe on a known path, that it stops accepting
connections before it exits, and that it reads configuration from the environment rather than from a
file baked into the image. Where an assumption fails, the deployment does not fail loudly. A target that
never passes its health check leaves the service in a rolling deployment that never completes, and a
process that ignores `SIGTERM` drops in-flight requests on every deploy while every dashboard stays
green.

Telling the user "add a health endpoint" in the pull request body hands the work back to them at the
exact moment they were expecting the tool to do it. Generating the change as a patch they can read costs
one diff and respects the fact that it is their code.

Each patch is offered separately, because the reasons for refusing them are unrelated. A team with a
carefully tuned multi-stage Dockerfile will not accept a generated one and may still want the graceful
shutdown fix. A single "prepare for deployment" commit means one objection to one hunk costs the user all
four changes, so the patches are separate branches and separate pull requests. Applying them
automatically was rejected outright: this tool does not own the repository, and a code change nobody read
is not something a generator should be able to merge.

Patches are derived from the analysis profile, never from a model, and each one states the fact that
triggered it together with the path that fact was read from -- "no `HEALTHCHECK` in `Dockerfile` and no
route matching `/health` under `src/routes`". A concern that cannot be traced to a fact is reported as a
gap and no patch is offered, which is the same rule the architecture proposal already follows for
capabilities with no service in the catalog.

Independence is enforced rather than asserted. Every patch is generated against the same analysed commit,
and the applicability test applies all sixteen subsets of the four patches. Where two patches would edit
the same lines -- a health route and a shutdown handler both landing in `src/index.ts` -- they are merged
into one patch with one title, because two patches that cannot both be taken are not independent no matter
how they are labelled.

### Contract

```typescript
// packages/core/src/patches/types.ts
export type PatchKind =
  | 'dockerfile'
  | 'health_endpoint'
  | 'graceful_shutdown'
  | 'twelve_factor_config';

export interface AppPatch {
  kind: PatchKind;
  title: string;
  /** The profile fact that triggered it, with the path it was read from. */
  rationale: string;
  /** Unified diff against `appliesToSha`, applicable with `git apply --3way`. */
  diff: string;
  files: string[];
  appliesToSha: string;
}

export interface PatchGap {
  kind: PatchKind;
  /** Why no patch could be generated, for example an unrecognised framework. */
  reason: string;
}

export interface PatchProposal {
  patches: AppPatch[];
  gaps: PatchGap[];
}

export function proposePatches(profile: AppProfile, ir: ArchitectureIr): PatchProposal;
```

```typescript
// apps/api/src/lib/patches/pull-request.ts
export interface OpenPatchPullRequestInput {
  experimentId: string;
  kind: PatchKind;
  owner: string;
  repo: string;
  baseSha: string;
}

/** One branch and one pull request per patch, via `openPullRequest` from issue 010. */
export function openPatchPullRequest(i: OpenPatchPullRequestInput): Promise<OpenedPullRequest>;
export function recordPatchDecision(i: RecordPatchDecisionInput): Promise<void>;
```

```
GET  /experiments/:id/patches                      -> 200 { patches, gaps }
POST /experiments/:id/patches/:kind/pull-request   -> 201 { pullRequestUrl } | 409
POST /experiments/:id/patches/:kind/decline        -> 204
```

```sql
CREATE TABLE patch_decisions (
  experiment_id uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  -- Keyed by commit: the same patch is offered again once the code moves on.
  commit_sha    text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('offered', 'declined', 'opened')),
  pull_request_url text,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, kind, commit_sha)
);
```

What each patch contains, concretely:

- `dockerfile` - a multi-stage build for the detected language and package manager, a non-root user, and
  a `HEALTHCHECK` hitting the same path the target group probes. Offered only when the repository has no
  Dockerfile.
- `health_endpoint` - a route returning 200 with `{"status":"ok"}` at the path the IR's target group
  probes, registered before any authentication middleware.
- `graceful_shutdown` - a `SIGTERM` handler that stops the listener, waits for in-flight requests up to
  the deregistration delay, then closes the database pool, in that order.
- `twelve_factor_config` - reads configuration from the environment with the current literal values as
  defaults, so behaviour is unchanged when no variable is set.

### Files

- CREATE `db/migrations/<timestamp>_patch_decisions.sql`
- CREATE `packages/core/src/patches/types.ts`
- CREATE `packages/core/src/patches/{dockerfile,health-endpoint,graceful-shutdown,twelve-factor}.ts`
- CREATE `packages/core/src/patches/propose.ts` - detection, merging of overlapping patches, gaps
- CREATE `packages/core/src/patches/propose.test.ts`
- CREATE `packages/core/src/patches/subsets.test.ts` - applies all sixteen subsets
- CREATE `apps/api/src/lib/patches/pull-request.ts`
- CREATE `apps/api/src/lib/db/patch-decisions.ts`
- CREATE `apps/api/src/routes/experiments/patches.ts`
- CREATE `apps/api/src/routes/experiments/patches.integration.test.ts`
- MODIFY `packages/core/src/index.ts` - export the patches module

### Acceptance Criteria

- [ ] Every offered patch states the profile fact and the file path that triggered it
- [ ] Each patch is opened as its own pull request; taking one never requires taking another
- [ ] Every one of the sixteen subsets of the offered patches applies with `git apply --3way` against the analysed commit
- [ ] Two patches that would edit the same lines are merged into one patch rather than offered as two
- [ ] A repository that already contains a Dockerfile is offered no Dockerfile patch
- [ ] An unrecognised framework yields a `PatchGap` with a reason, not a guessed patch
- [ ] A declined patch is not offered again for the same commit, and is offered again once the commit changes
- [ ] No patch is written to the repository without an explicit request to the pull-request endpoint
- [ ] The health endpoint patch serves the exact path the IR's target group probes
- [ ] The twelve-factor patch changes no effective default, so the application behaves identically with no variables set

### Required Tests

- `states the profile fact behind every offered patch`
- `offers no dockerfile patch when the repository already has one`
- `applies every subset of the offered patches to the analysed commit`
- `merges two patches that would edit the same lines`
- `generates the health route on the path the target group probes`
- `stops the listener before closing the database pool in the shutdown patch`
- `keeps existing literal values as defaults in the twelve factor patch`
- `reports an unrecognised framework as a gap rather than guessing`
- `does not offer a patch that was declined for the same commit`
- `offers a declined patch again once the commit changes`

### Performance Budget

Proposing all patches for a repository the size of this one completes in under 2 seconds and writes no
working copy to disk; file contents are read through the GitHub API and diffed in memory. The subset
applicability test completes in under 20 seconds under `pnpm test`.

### Out of Scope

- Do not change the infrastructure pull-request path in `docs/issues/epic-12-launch/010-infrastructure-pull-request.md`; reuse `openPullRequest`
- Do not modify the detection rules in `packages/core/src/analysis/profile.ts`; consume the profile as produced
- Do not run the user's tests, linters, or formatters against a patched tree
- Do not generate patches for framework upgrades, dependency bumps, or code style
- Do not add a diff viewer to the web app; the endpoints return the diffs and Epic 11 (#12) renders them

### Dependencies

Blocked by #27, and by the pull-request helper in
`docs/issues/epic-12-launch/010-infrastructure-pull-request.md`.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test:integration
gh pr view "$PR_URL" --json files,mergeable
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
