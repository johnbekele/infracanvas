---
title: '[infra] Run k6 on Fargate Spot with a ramp that finds the knee point'
labels: tier:1, size:l, area:infra, area:api, epic:10-loadtest
---

### Epic

#11

### Context

The load generator has to sit next to the deployment, not next to the developer. A test driven from a
laptop measures a home connection: upstream bandwidth, the ISP's NAT table, and a wireless link all
saturate long before a load-balanced service does, and the resulting number describes the tester. A
task in the same region as the deployment removes that variable.

Fargate Spot rather than on-demand Fargate. A ramp to a few thousand requests per second needs
roughly 4 vCPU and 8 GB for fifteen to twenty minutes; Spot capacity for that shape is priced around
70 per cent below on-demand, and the workload is the ideal Spot candidate because it is short, has no
state worth preserving, and is cheap to repeat. Paying three times as much to protect a run that can
simply be run again is not a trade worth making when the guardrail this platform advertises is
"experiments do not produce surprise bills".

Lambda was rejected as the generator: the fifteen-minute ceiling caps ramp length, there is no
control over connection reuse across invocations, and cold starts land inside the measurement window,
which corrupts exactly the percentile the report exists to state.

Interruption has to be handled honestly, because the tempting behaviour is the wrong one. When Spot
capacity is reclaimed, ECS stops the task with a stopped reason naming the interruption and the
container receives `SIGTERM` with roughly two minutes of grace. The container flushes whatever k6 has
written so far, so the samples are available for debugging, but the run is recorded `interrupted` and
an interrupted run never produces a measured SLI: a ramp cut off at stage four cannot distinguish "the
system held" from "the test stopped". The runner retries once, and the retry uses on-demand capacity,
so a capacity shortage costs one extra attempt rather than blocking the user. A third attempt is
refused, because a loop that keeps launching tasks is how a cost guardrail turns into a cost
incident.

The ramp exists to find the knee point rather than to prove a number. Stages step the arrival rate
upwards and the run aborts once the error rate or the p99 crosses its limit for two consecutive
stages; the knee point is the highest completed stage that stayed inside both. Running every stage to
the end after the system has already failed spends money to gather data nobody uses.

The task is given no AWS permissions at all. The script arrives through a presigned GET and the raw
samples leave through a presigned PUT, both expiring in thirty minutes. A task role with S3 write
access would be a standing capability inside a container that runs user-derived scripts; a URL that
expires is not.

Spec: `docs/DATABASE.md`

### Contract

```sql
CREATE TYPE loadtest_run_status AS ENUM (
  'queued', 'running', 'completed', 'interrupted', 'failed'
);

CREATE TABLE loadtest_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   uuid NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  deployment_id   uuid NOT NULL REFERENCES deployments (id) ON DELETE CASCADE,
  status          loadtest_run_status NOT NULL DEFAULT 'queued',
  -- 'FARGATE_SPOT' on the first attempt, 'FARGATE' on the retry after an interruption.
  capacity_provider text NOT NULL,
  attempt         integer NOT NULL DEFAULT 1,
  ecs_task_arn    text,
  script_sha256   text NOT NULL,
  profile         jsonb NOT NULL,
  -- Verbatim from ECS, so an interruption can be told apart from an application failure.
  stopped_reason  text,
  raw_samples_uri text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (attempt BETWEEN 1 AND 2)
);

CREATE INDEX loadtest_runs_experiment_idx ON loadtest_runs (experiment_id, created_at DESC);
-- One live run per deployment: two generators against one target measure neither.
CREATE UNIQUE INDEX loadtest_runs_one_active_idx ON loadtest_runs (deployment_id)
  WHERE status IN ('queued', 'running');
```

```typescript
// apps/api/src/lib/loadtest/ramp-profile.ts
export interface RampProfile {
  stages: readonly RampStage[]; // targetRps strictly increasing
  preAllocatedVus: number;
  maxVus: number;
  abortP99Ms: number;
  abortErrorRate: number; // 0.01
}

export class InvalidRampProfileError extends Error {}

/** Twelve stages from 10 per cent to 400 per cent of the predicted rate, 60 s each. */
export function defaultRampProfile(predictedRps: number): RampProfile;
```

```typescript
// apps/api/src/lib/loadtest/runner.ts
export interface StartLoadTestInput {
  experimentId: string;
  deploymentId: string;
  script: GeneratedK6Script;
  profile: RampProfile;
}

export function startLoadTest(input: StartLoadTestInput): Promise<LoadTestRun>;
/** Reads the ECS task, maps its stopped reason to a status, and persists the transition. */
export function pollLoadTest(runId: string): Promise<LoadTestRun>;
export function stopLoadTest(runId: string, reason: string): Promise<LoadTestRun>;

/** True when ECS stopped the task because Spot capacity was reclaimed. */
export function isSpotInterruption(stoppedReason: string): boolean;
```

The task definition is registered from code under the fixed family `infracanvas-k6-runner`, once per
image digest, rather than being maintained by hand: the digest changes whenever the k6 version does,
and the version that produced a measurement has to be recorded next to it.

```typescript
// apps/api/src/lib/loadtest/task-definition.ts
export const RUNNER_FAMILY = 'infracanvas-k6-runner';
/** Idempotent: returns the existing revision when the digest and resources already match. */
export function ensureRunnerTaskDefinition(imageDigest: string): Promise<string>;
```

The container image adds `curl` to the pinned k6 image and nothing else. `stopTimeout` is 100 seconds,
inside the two-minute Spot grace period, so the flush completes before the task is killed:

```dockerfile
# docker/k6-runner/Dockerfile
FROM grafana/k6:0.51.0
USER root
RUN apk add --no-cache curl
COPY entrypoint.sh /entrypoint.sh
USER k6
ENTRYPOINT ["/entrypoint.sh"]
```

```bash
# docker/k6-runner/entrypoint.sh
set -euo pipefail
trap 'upload; exit 143' TERM   # Spot reclaim: flush what exists, then exit
curl -fsS "$SCRIPT_URL" -o /tmp/script.js
curl -fsS "$DATA_URL"   -o /tmp/data.json
k6 run --out "json=/tmp/samples.json" --summary-export /tmp/summary.json /tmp/script.js &
wait $!
upload
```

### Files

- CREATE `db/migrations/<timestamp>_loadtest_runs.sql`
- CREATE `apps/api/src/lib/db/loadtest-runs.ts`
- CREATE `apps/api/src/lib/loadtest/ramp-profile.ts`
- CREATE `apps/api/src/lib/loadtest/task-definition.ts`
- CREATE `apps/api/src/lib/loadtest/runner.ts`
- CREATE `apps/api/src/lib/loadtest/runner.test.ts`
- CREATE `apps/api/src/lib/db/loadtest-runs.integration.test.ts`
- CREATE `apps/api/src/routes/experiments/loadtest.ts` - start, poll, stop
- CREATE `docker/k6-runner/Dockerfile`, `docker/k6-runner/entrypoint.sh`
- MODIFY `.github/workflows/release.yml` - build and push the runner image by digest

### Acceptance Criteria

- [ ] A run launches with capacity provider `FARGATE_SPOT` and its task ARN is persisted before the call returns
- [ ] A task whose stopped reason names a Spot interruption is recorded `interrupted`, not `completed` or `failed`
- [ ] An interrupted run is retried exactly once, and the retry launches with capacity provider `FARGATE`
- [ ] A second interruption records `interrupted` and launches nothing further
- [ ] An interrupted run produces no measured SLI even when partial samples were uploaded
- [ ] A ramp profile whose stage rates do not strictly increase is refused with `InvalidRampProfileError`
- [ ] The run aborts within one stage of the error rate or p99 limit being crossed twice, rather than completing every stage
- [ ] The knee point recorded is the highest completed stage that stayed inside both limits
- [ ] The runner task role grants no AWS API permissions; the script and samples move over presigned URLs that expire in 30 minutes
- [ ] A second run against a deployment that already has a live run is refused by the database, not by application code alone
- [ ] Destroying an experiment stops any running task, and the recorded stopped reason names the platform as the cause

### Required Tests

- `launches on spot capacity and records the task arn`
- `records a spot interrupted task as interrupted rather than failed`
- `retries an interrupted run once on on demand capacity`
- `refuses a third attempt after two interruptions`
- `produces no measurement for an interrupted run`
- `rejects a ramp profile whose stages do not increase`
- `records the knee point as the last stage inside both limits`
- `rejects a second concurrent run against the same deployment`
- `stops the running task when the experiment is destroyed`
- `reuses the existing task definition revision for an unchanged image digest`

### Performance Budget

The task reaches `RUNNING` within 90 seconds of `startLoadTest` at p50, measured from the `created_at`
and `started_at` columns over ten launches. A twelve-stage profile to 2000 RPS finishes within 20
minutes of wall clock and under 0.20 USD of Spot compute at 4 vCPU and 8 GB. The generator must not
be the bottleneck: task CPU utilisation stays under 70 per cent for every completed stage, read from
the ECS task metrics, and a run that exceeds it is recorded with `confidence` degraded rather than
reported as a system limit.

### Out of Scope

- Do not create the VPC, subnets, cluster, or security groups; those come from the deploy epic (#10)
- Do not implement the metrics join or compute SLIs; that is `docs/issues/epic-10-loadtest/030-metrics-join.md`
- Do not change the script generator; this issue consumes `GeneratedK6Script` as it is
- Do not add distributed multi-task k6 or a second generator region
- Do not touch the CodeBuild deployment path in the deploy epic, even though both launch AWS work

### Dependencies

Blocked by #27 and #28, by the deploy stack from Epic 9 (#10), and by the script generator in
`docs/issues/epic-10-loadtest/010-k6-script-generation.md`.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/api test:integration
docker build -t infracanvas/k6-runner:local docker/k6-runner
aws ecs describe-tasks --cluster infracanvas-loadtest --tasks "$TASK_ARN" \
  --query 'tasks[0].[lastStatus,stoppedReason,capacityProviderName]'
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:l - over 600 lines
