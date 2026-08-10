---
title: '[infra] One-click destroy that proves nothing was left behind'
labels: tier:1, size:m, area:infra, epic:9-deploy
---

### Epic

#10

### Context

The promise that makes this platform safe to try is that anything it creates can be removed by one
click. That promise is only as good as its weakest resource: a single forgotten NAT gateway costs more
per month than most of the experiment did, and the user finds out on their statement rather than from
us.

**Verifying beats assuming.** `pulumi destroy` exiting zero means Pulumi deleted everything in its own
state file. It says nothing about resources AWS created on Pulumi's behalf, resources a partially
failed earlier deploy created before its state was written, or resources someone added to the stack by
hand. So a successful destroy is not the end of the operation: the account is queried for anything still
tagged with this experiment, and the deployment is only recorded as destroyed when that query comes back
empty. Trusting the exit code would make the strongest claim in the product the one thing nobody checks.

**Orphans are reported, not hidden.** When the sweep still finds resources after its retries, the
correct outcome is not to retry forever and not to mark the experiment destroyed anyway. It is to record
the exact ARNs, mark the deployment `orphaned`, and leave the experiment `failed`, so a person has a
list they can act on and the reaper does not keep charging at a resource it cannot delete. A destroy
that quietly gives up is how a platform accumulates a bill nobody can attribute.

**The tagging API is eventually consistent, which changes the shape of the check.** The Resource Groups
Tagging API indexes asynchronously, so a resource deleted seconds ago can still appear and one created
recently can be missing. A single query would produce both false alarms and false clearances, which is
why the sweep retries with a delay and treats only a repeated empty result as proof. It is also regional
and does not index IAM, whose tags are visible only from the partition's global endpoint region, so a
sweep covers the deployment's region plus that one.

**Buckets and log groups are the two known awkward cases.** S3 refuses to delete a non-empty bucket, so
the emitters set `force_destroy=True`. Lambda creates `/aws/lambda/<name>` log groups itself, outside
Pulumi's state and without our tags, so the sweep deletes any log group whose name carries this
experiment's prefix. That deletion is the one place destroy does work rather than checking work, and it
is safe precisely because the name contains the experiment id.

Spec: `docs/AWS.md`, `docs/DATABASE.md`

### Contract

```ts
// apps/api/src/lib/deploy/sweep.ts
export interface OrphanedResource {
  readonly arn: string;
  readonly resourceType: string;
  readonly region: string;
}
export interface SweepReport {
  readonly sweptAt: string; // ISO 8601, UTC
  readonly regions: readonly string[];
  readonly attempts: number;
  readonly remaining: readonly OrphanedResource[];
  readonly logGroupsDeleted: readonly string[];
  readonly clean: boolean; // remaining.length === 0 on the final attempt
}

/**
 * Queries GetResources by tag in every region, paginating on PaginationToken, and
 * retries up to `attempts` times with `delayMs` between them because the tag index
 * is eventually consistent.
 */
export function sweepExperiment(
  credentials: AwsCredentials,
  regions: readonly string[],
  experimentId: string,
  options?: { attempts?: number; delayMs?: number }
): Promise<SweepReport>;

// apps/api/src/lib/deploy/destroy.ts
export interface DestroyResult {
  readonly outcome: BuildOutcome | 'nothing_to_destroy';
  readonly buildId: string | null;
  readonly sweep: SweepReport;
}
/** Runs the destroy build, then sweeps. Safe to call on an already-destroyed experiment. */
export function runDestroy(input: RunDestroyInput, ctx: JobContext): Promise<DestroyResult>;
```

The handler, kind `deploy.destroy`, registered on the worker from #29:

1. Take `pg_advisory_xact_lock(hashtext(experiment_id))`. Refuse with 409 while the experiment is
   `deploying`; return the stored sweep unchanged when it is already `destroyed`.
2. Set the experiment `destroying`, assume the connection, and `ensureBootstrap`.
3. When the experiment has no deployment row, skip the build with outcome `nothing_to_destroy` and go
   straight to the sweep, because a failed deploy can still have created resources.
4. Otherwise `StartBuild` on the same project and the same source object the deploy used, overriding
   `PULUMI_COMMAND=destroy`. Logs stream through the same `JobContext` as a deploy, so the browser sees
   destroy output on the existing SSE channel.
5. Sweep with three attempts and 30 seconds between them, over
   `[deployment.aws_region, env.AWS_GLOBAL_TAGGING_REGION]` deduplicated.
6. Write the report to `deployments.outputs.destroy_sweep`, which is the audit record. On `clean`, set
   the deployment `destroyed` and the experiment `destroyed`. Otherwise set the deployment `orphaned`
   and the experiment `failed`, and log one line per remaining ARN.

`AWS_GLOBAL_TAGGING_REGION` is declared in `apps/api/src/lib/env.ts` with a default carrying a trailing
`infracanvas-allow: no-hardcoded-region` comment, because IAM's tag index genuinely exists in exactly
one region per partition and configuration cannot change that fact.

Route: `POST /experiments/:id/destroy` returns 202 with the job id, 200 with the previous sweep when the
experiment is already destroyed, and 409 while a deploy is in flight.

### Files

- CREATE `apps/api/src/lib/deploy/sweep.ts`
- CREATE `apps/api/src/lib/deploy/destroy.ts`
- CREATE `apps/api/src/lib/jobs/handlers/destroy.ts`
- CREATE `apps/api/src/routes/experiments/destroy.ts`
- CREATE `apps/api/src/lib/deploy/sweep.test.ts`
- CREATE `apps/api/src/lib/deploy/destroy.test.ts`
- CREATE `apps/api/src/lib/jobs/handlers/destroy.integration.test.ts`
- CREATE `apps/api/src/lib/deploy/__fixtures__/get-resources-paged.json`
- CREATE `apps/api/src/lib/deploy/__fixtures__/get-resources-orphan.json`
- MODIFY `apps/api/package.json` - add `@aws-sdk/client-resource-groups-tagging-api`
- MODIFY `apps/api/src/lib/env.ts` - add `AWS_GLOBAL_TAGGING_REGION`, `DESTROY_SWEEP_ATTEMPTS`
- MODIFY `apps/api/src/index.ts` - register the destroy handler and mount the route
- MODIFY `apps/api/.env.example` - document the new variables

### Acceptance Criteria

- [ ] A destroy whose build succeeds and whose sweep is empty marks both deployment and experiment
      `destroyed`
- [ ] A destroy whose sweep still finds a resource marks the deployment `orphaned`, not `destroyed`
- [ ] Every remaining ARN appears in `deployments.outputs.destroy_sweep` and in the streamed log
- [ ] The sweep pages through `GetResources` until `PaginationToken` is absent
- [ ] The sweep covers the deployment's region and the global tagging region, and no others
- [ ] A resource that appears on the first attempt and is gone on the second is not reported as an
      orphan
- [ ] An experiment with no deployment row is still swept, and is destroyed without a build
- [ ] Destroying an already-destroyed experiment returns the previous sweep and starts no build
- [ ] Destroying an experiment mid-deploy is refused with 409
- [ ] A `/aws/lambda/` log group carrying the experiment prefix is deleted and listed in the report
- [ ] A failed destroy build leaves the experiment `failed` and never `destroyed`

### Required Tests

- `marks the experiment destroyed only when the sweep is empty`
- `marks the deployment orphaned when a resource remains`
- `records every remaining arn in the sweep report`
- `pages through every tagged resource`
- `sweeps the deployment region and the global tagging region only`
- `tolerates a stale tag index entry that clears on retry`
- `sweeps an experiment that has no deployment row`
- `is idempotent for an already destroyed experiment`
- `refuses to destroy while a deploy is in flight`
- `deletes a service created lambda log group`
- `leaves the experiment failed when the destroy build fails`

### Performance Budget

A destroy of a 20-resource stack completes within 5 minutes end to end, of which the sweep accounts for
at most 90 seconds: three attempts, 30 seconds apart, each at most two `GetResources` pages per region.
The sweep issues no more than 8 AWS calls per attempt, so it stays clear of the tagging API's request
rate limit even when the reaper destroys several experiments at once.

### Out of Scope

- Do not delete the state bucket, KMS key, deploy role, or CodeBuild project; they are shared by every
  experiment in that account
- Do not delete the experiment or deployment rows; the sweep report is the record of what happened and
  #27 keeps it
- Do not implement the TTL or budget triggers; they call this handler and are specified in
  `docs/issues/epic-9-deploy/050-ttl-and-budget-reaper.md`
- Do not add an `artifact_kind` value for the sweep report; it belongs to a deployment, not to the
  experiment
- Do not attempt to delete an orphan directly with a service API; report it instead, because a delete
  we cannot express in Pulumi is a delete we cannot reason about

### Dependencies

Blocked by #27 for the deployment row and its `outputs` column, #29 for the worker and the SSE stream,
and by `docs/issues/epic-9-deploy/030-codebuild-deploy-with-log-stream.md`. Relies on the emitters in
`docs/issues/epic-8-codegen/010-pulumi-python-emitter.md` setting `force_destroy=True` on buckets and
prefixing physical names with the experiment id.

### Verification

```bash
pnpm --filter @infracanvas/api test
docker compose --profile aws up -d localstack
AWS_ENDPOINT_URL=http://localhost:4566 pnpm --filter @infracanvas/api test:integration
curl -s -X POST localhost:3001/experiments/$ID/destroy
psql "$DATABASE_URL" -c "SELECT outputs -> 'destroy_sweep' FROM deployments WHERE experiment_id = '$ID'"
```

Testing without a real AWS account: the sweep is driven with `aws-sdk-client-mock` replaying recorded
`GetResources` responses - a two-page clean result, a result with one orphan, and a pair of responses
where the first attempt shows a resource the second does not, which is the eventual-consistency case no
emulator reproduces on demand. LocalStack covers `DescribeLogGroups` and `DeleteLogGroup`, and its
tagging API support is partial enough that the fixture tests are the authoritative ones. The destroy
build itself is mocked exactly as the deploy build is. That leaves one claim unproven locally, that a
real `pulumi destroy` plus this sweep genuinely empties an account: it is checked once per release by
deploying the `every-supported-type` fixture into the sandbox account, destroying it, and confirming
both an empty sweep and an empty console, recorded on the pre-release checklist in `docs/AWS.md`.

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
