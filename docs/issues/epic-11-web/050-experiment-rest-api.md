---
title: '[api] Experiment REST API with forking and an append-only revision endpoint'
labels: tier:2, size:l, area:api, epic:11-ui
---

### Epic

#12

### Context

`apps/api/src/routes/experiments/` does not exist, and seven specified issues already write files
into it: `events.ts` (#29), `deploy.ts` (#111), `destroy.ts` (#112), `loadtest.ts` (#70),
`loadtest-script.ts` (#69), `loadtest-report.ts` (#72) and `patches.ts` in the launch epic. Not one of
them creates the router, mounts it in `apps/api/src/index.ts`, or provides the ownership check every
one of them needs before it touches an experiment id from a URL. Seven agents each writing their own
guard produces seven guards, and the useful thing to know about a set of seven hand-written
authorisation checks is that one of them is wrong. This issue lands the router, the mount, and one
`requireExperiment` the rest reuse.

The ownership rule is the one `apps/api/src/lib/db/repositories.ts` already sets: the owner is part
of the lookup, not a check performed afterwards, and an experiment belonging to another user reads as
404 rather than 403. Answering 403 confirms the id exists, which turns a uuid guess into an
enumeration oracle for who is testing what.

**Forking is the feature, not a convenience.** Comparison needs two experiments over one repository
that differ in a way the user chose, and the realistic way to get there is to take the architecture
you have and change one thing. Without a fork the user retypes the hypothesis, re-runs the analysis,
re-lays out the canvas, and the two experiments differ in a dozen incidental ways that make the
comparison meaningless. So a fork copies exactly the architecture and nothing that was measured about
it. Copying the deployment and its load-test run was considered, because it makes a fresh fork look
populated; it was rejected outright, since it would attribute a measurement to an architecture that
has never been deployed, and the comparison view exists specifically to stop a prediction and a
measurement being printed as if they were the same kind of number. Copying the full revision chain
was also rejected: the chain answers "how did this experiment get here", and a fork's history begins
at the fork. The origin is recorded on the experiment row instead, as
`forked_from_experiment_id` and `forked_from_revision_id`.

Creating a revision is an append, not a save. The client sends the document it edited together with
the revision it started from, and a parent that is no longer the head is a 409 rather than a silent
overwrite. Two browser tabs on one experiment is an ordinary thing, and last-write-wins over an
architecture that has been priced is how a user ends up deploying something they did not draw.

Spec: `docs/issues/epic-1-data/140-experiment-hypothesis-and-ir-revisions.md`

### Contract

Every route requires a session and is scoped to the caller. The router applies `apiRateLimit` and
`requireAuth` in that order, matching `apps/api/src/routes/repositories/index.ts`.

| Method   | Path                                | Success                        | Failures      |
| -------- | ----------------------------------- | ------------------------------ | ------------- |
| `POST`   | `/experiments`                      | `201 { experiment, revision }` | 400, 404, 409 |
| `GET`    | `/experiments`                      | `200 { experiments }`          | -             |
| `GET`    | `/experiments/:id`                  | `200 { experiment, head }`     | 404           |
| `PATCH`  | `/experiments/:id`                  | `200 { experiment }`           | 400, 404      |
| `POST`   | `/experiments/:id/fork`             | `201 { experiment, revision }` | 400, 404      |
| `DELETE` | `/experiments/:id`                  | `204`                          | 404, 409      |
| `GET`    | `/experiments/:id/revisions`        | `200 { revisions }`            | 404           |
| `GET`    | `/experiments/:id/revisions/:revId` | `200 { revision }`             | 404           |
| `POST`   | `/experiments/:id/revisions`        | `201 { revision }`             | 400, 404, 409 |

```typescript
// apps/api/src/routes/experiments/types.ts
import type { ArchitectureIr } from '@infracanvas/ir-schema';
import type {
  Experiment,
  ExperimentVerdict,
  ExperimentRevision,
  IrRevisionSource,
  JsonPatchOperation,
  RevisionSummary,
} from '../../lib/db/experiment-revisions.js';

export interface CreateExperimentBody {
  repositoryId: string;
  name: string;
  /** Required and non-empty. An experiment with no hypothesis is a drawing. */
  hypothesis: string;
  /**
   * Seeds revision 1. When omitted the server runs `proposeArchitecture` over the
   * repository's newest succeeded analysis, so the ordinary path sends neither an
   * IR nor a layout.
   */
  ir?: ArchitectureIr;
  /** Defaults from `EXPERIMENT_DEFAULT_BUDGET_USD`; the CHECK from #27 refuses zero. */
  budgetUsd?: number;
  /** Defaults from `EXPERIMENT_DEFAULT_TTL_HOURS`; sets `expires_at` at creation. */
  ttlHours?: number;
}

export interface PatchExperimentBody {
  name?: string;
  hypothesis?: string;
  verdict?: ExperimentVerdict;
  /** Required whenever `verdict` is present and not `undecided`. */
  verdictNote?: string;
  archived?: boolean;
}

export interface ForkExperimentBody {
  /** Defaults to the source experiment's head. This is how a user branches from history. */
  fromRevisionId?: string;
  /** Defaults to `${source.name} (fork)`, deduplicated with a numeric suffix. */
  name?: string;
  /** Defaults to the source hypothesis. A fork that tests the same thing is a copy. */
  hypothesis?: string;
}

export interface CreateRevisionBody {
  /** The revision the client edited. A non-head value is a 409, never a merge. */
  parentRevisionId: string;
  ir: ArchitectureIr;
  summary: string;
  source: IrRevisionSource;
  /** Optional. Verified against the documents when sent, computed when not. */
  patch?: JsonPatchOperation[];
}

export interface ExperimentResponse {
  experiment: Experiment;
  head: RevisionSummary | null;
}

export interface ListExperimentsResponse {
  experiments: (Experiment & {
    revisionCount: number;
    head: RevisionSummary | null;
    repository: { id: string; githubOwner: string; githubName: string } | null;
  })[];
}

export interface RevisionResponse {
  revision: ExperimentRevision;
}

export interface ListRevisionsResponse {
  revisions: RevisionSummary[];
}

/** 400 body when the submitted document fails `validateIr`. */
export interface IrRejectedResponse {
  error: 'The architecture is not a valid IR document';
  problems: { pointer: string; message: string; source: 'schema' | 'reference' }[];
}

/** 409 body when the parent is stale. Carries the head so the client can rebase. */
export interface RevisionConflictResponse {
  error: 'This experiment has moved on since the revision you edited';
  headRevisionId: string;
  headSeq: number;
}
```

```typescript
// apps/api/src/routes/experiments/require-experiment.ts
import type { RequestHandler } from 'express';

declare global {
  namespace Express {
    interface Request {
      experiment?: Experiment;
    }
  }
}

/**
 * Loads `req.params.id` scoped to `req.session.userId` and attaches it, or ends the
 * request with 404. Mounted once on the router, so every sibling route file added by
 * #29, #70, #111 and #112 gets the same check without writing one.
 */
export const requireExperiment: RequestHandler;
```

```typescript
// apps/api/src/lib/experiments/fork.ts
export interface ForkInput {
  userId: string;
  sourceExperimentId: string;
  fromRevisionId?: string;
  name?: string;
  hypothesis?: string;
}

/**
 * Copies the architecture and nothing that was observed about it. See the table
 * below for the exact split, which is asserted field by field in fork.test.ts.
 */
export function forkExperiment(
  input: ForkInput
): Promise<{ experiment: Experiment; revision: ExperimentRevision } | null>;
```

What a fork copies, and what it does not:

| Field                       | Fork behaviour                                                         |
| --------------------------- | ---------------------------------------------------------------------- |
| `repository_id`             | Copied. A fork over a different repository is not a comparison         |
| `name`                      | `${source.name} (fork)` unless the body supplies one                   |
| `hypothesis`                | Copied unless the body supplies one                                    |
| `budget_usd`                | Copied. The comparison is only fair under the same cap                 |
| `expires_at`                | Recomputed as `now() + ttl`, never copied, so a fork is not born stale |
| architecture                | Exactly one revision, holding `fromRevisionId`'s `ir` and `ir_version` |
| revision history            | Not copied. The fork's chain starts at `seq` 1 with `source: 'fork'`   |
| `forked_from_experiment_id` | Set to the source experiment                                           |
| `forked_from_revision_id`   | Set to `fromRevisionId`, resolved to the head when omitted             |
| `status`                    | Reset to `draft`                                                       |
| `verdict`                   | Reset to `undecided`, with a null note and date                        |
| deployments                 | Not copied. Nothing has been deployed from this architecture           |
| artifacts                   | Not copied, including generated Pulumi and any cost report             |
| load-test runs and SLIs     | Not copied. A measurement belongs to the deployment that produced it   |

Behaviour the signatures do not carry:

- `POST /experiments` refuses with 409 when the repository has no succeeded analysis and the body
  carries no `ir`, naming the analysis the user has to run. Seeding from a failed or absent profile
  would produce an empty architecture that looks like a product bug.
- Every submitted `ir` runs through `validateIr` from `@infracanvas/ir-schema` (#77) before it
  reaches the database, and a failure is a 400 carrying the problems, never a 500.
- `POST /experiments/:id/revisions` verifies a supplied `patch` by applying it to the parent document
  and comparing with the submitted one; a mismatch is a 400. When no patch is sent the server
  computes one. The document remains the authority in both cases.
- `DELETE /experiments/:id` refuses with 409 while `status` is `deploying`, `testing` or `destroying`,
  because deleting the row is how a running stack becomes an untracked stack in someone's AWS
  account. A deployed experiment is deleted only after `POST /experiments/:id/destroy` (#112).
- `PATCH` with `verdict` and no `verdictNote` is a 400 rather than a constraint violation surfacing
  as a 500; the database CHECK from the data issue is the backstop, not the error message.
- The router mounts sibling files as they land. This issue creates only `index.ts`, `revisions.ts`,
  `require-experiment.ts` and `types.ts`, and adds no route that #29, #69, #70, #72, #111 or #112
  already owns.

### Files

- CREATE `apps/api/src/routes/experiments/index.ts` - router, CRUD, fork, and the mount points
- CREATE `apps/api/src/routes/experiments/revisions.ts`
- CREATE `apps/api/src/routes/experiments/require-experiment.ts`
- CREATE `apps/api/src/routes/experiments/types.ts`
- CREATE `apps/api/src/lib/experiments/fork.ts`
- CREATE `apps/api/src/lib/experiments/seed.ts` - build revision 1 from the newest succeeded analysis
- CREATE `apps/api/src/lib/experiments/fork.test.ts`
- CREATE `apps/api/src/lib/experiments/seed.test.ts`
- CREATE `apps/api/src/routes/experiments/experiments.integration.test.ts`
- CREATE `apps/api/src/routes/experiments/revisions.integration.test.ts`
- MODIFY `apps/api/src/index.ts` - mount the router at `/experiments`
- MODIFY `apps/api/src/lib/env.ts` - `EXPERIMENT_DEFAULT_TTL_HOURS`, `EXPERIMENT_DEFAULT_BUDGET_USD`
- MODIFY `apps/api/.env.example` - document both variables

### Acceptance Criteria

- [ ] Every route returns 404, not 403, for an experiment belonging to another user
- [ ] A malformed experiment id in a URL returns 404 rather than a 500 from a rejected uuid cast
- [ ] `POST /experiments` with no `ir` seeds revision 1 from the repository's newest succeeded analysis and records `source: 'proposal'`
- [ ] `POST /experiments` against a repository with no succeeded analysis returns 409 naming the analysis to run, and creates no row
- [ ] An `ir` that fails `validateIr` returns 400 with the problem pointers and creates no row
- [ ] `GET /experiments` returns only the caller's experiments, newest first, excluding archived ones unless asked
- [ ] `GET /experiments/:id` returns the head revision summary without the IR document
- [ ] `PATCH` renames without touching the revision chain, and the head revision id is unchanged afterwards
- [ ] `PATCH` with a verdict and no note returns 400 and leaves the verdict untouched
- [ ] `POST /experiments/:id/fork` creates an experiment with exactly one revision whose `ir` is byte-identical to the source revision's
- [ ] A fork has no deployments, no artifacts, no load-test runs, `status: 'draft'` and `verdict: 'undecided'`
- [ ] A fork records `forked_from_experiment_id` and `forked_from_revision_id`, and forking from an explicit older revision records that revision rather than the head
- [ ] A fork's `expires_at` is computed from the time of the fork, not copied from the source
- [ ] Forking an experiment the caller does not own returns 404 and creates nothing
- [ ] `POST /experiments/:id/revisions` with a stale `parentRevisionId` returns 409 carrying the current head id and seq, and appends nothing
- [ ] A supplied `patch` that does not take the parent document to the submitted one returns 400
- [ ] A revision created with no `patch` is stored with one the server computed, and applying it to the parent reproduces the document
- [ ] `DELETE` returns 409 while the experiment is deploying, testing or destroying
- [ ] `GET /experiments/:id/revisions/:revId` for a revision belonging to a different experiment returns 404

### Required Tests

- `returns 404 for another user's experiment on every route`
- `returns 404 rather than 500 for a malformed experiment id`
- `seeds the first revision from the newest succeeded analysis`
- `refuses to create an experiment when the repository has never been analysed`
- `rejects an invalid ir document with pointers and writes nothing`
- `lists only the caller's experiments and hides archived ones by default`
- `renames without moving the head revision`
- `rejects a verdict submitted without a note`
- `forks the architecture byte for byte into a single revision`
- `does not copy deployments artifacts or load test runs into a fork`
- `records the source revision when forking from history rather than the head`
- `gives a fork a fresh expiry rather than the source expiry`
- `rejects a revision whose parent is not the head and returns the current head`
- `rejects a patch that does not reproduce the submitted document`
- `computes a patch when the client sends none`
- `refuses to delete an experiment while it is deploying`
- `refuses to read a revision through the wrong experiment`

### Performance Budget

`GET /experiments` for a user with 200 experiments completes in under 120ms and issues a fixed number
of queries regardless of the count, so the revision count and head summary are joined rather than
fetched per row; the integration test counts queries with a pool spy. `GET /experiments/:id/revisions`
never selects the `ir` column. `POST /experiments/:id/revisions` completes in under 200ms for a
500-node document, dominated by `validateIr`, whose own budget is 10ms in #77.

### Out of Scope

- Do not add deploy, destroy, load-test, events or patches routes; those files belong to #111, #112,
  #70, #29 and the launch epic, and this issue only leaves the mount points for them
- Do not compute cost, latency, availability or Well-Architected findings here; the prediction plane
  is #8 and this API stores documents rather than judging them
- Do not add a diff endpoint; the structural diff is computed for the comparison view in
  `docs/issues/epic-11-web/080-experiment-comparison.md`
- Do not build any UI. The list and workspace are
  `docs/issues/epic-11-web/060-experiments-list-and-entry-point.md` and
  `docs/issues/epic-11-web/070-experiment-workspace-page.md`
- Do not implement merge, rebase or three-way resolution for a stale parent. A 409 and a rebase in
  the client is the whole conflict story
- Do not change `apps/api/src/routes/repositories/` beyond leaving it as it is; an experiment
  references a repository and does not replace one

### Dependencies

Blocked by #27 and by `docs/issues/epic-1-data/140-experiment-hypothesis-and-ir-revisions.md` for the
tables and the data access module, and by #77 for `validateIr` and the `ArchitectureIr` type. Seeding
revision 1 uses `proposeArchitecture` and the IR conversion from #79.

### Verification

```bash
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test:integration
curl -s -X POST localhost:3001/experiments -H 'content-type: application/json' \
  -d '{"repositoryId":"'"$REPO"'","name":"Aurora Serverless","hypothesis":"cheaper under bursty load"}'
curl -s localhost:3001/experiments
curl -s -X POST localhost:3001/experiments/$ID/fork -d '{}' -H 'content-type: application/json'
psql "$DATABASE_URL" -c "SELECT e.name, e.forked_from_experiment_id, count(r.id) FROM experiments e LEFT JOIN experiment_revisions r ON r.experiment_id = e.id GROUP BY 1, 2"
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines. The nine handlers, the shared ownership guard, the fork, and the seeding
path are one contract: shipping the CRUD half without the revision half leaves an object with no
architecture in it, and shipping either without `requireExperiment` is what this issue exists to
prevent.
