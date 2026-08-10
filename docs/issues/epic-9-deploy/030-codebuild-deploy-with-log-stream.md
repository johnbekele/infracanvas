---
title: '[infra] Run the deploy in CodeBuild and stream its logs to the browser'
labels: tier:1, size:l, area:infra, epic:9-deploy
---

### Epic

#10

### Context

A deploy takes minutes and can fail in a dozen places, most of them inside Pulumi where only the log
explains what happened. A progress spinner that resolves into "deploy failed" ten minutes later is
worse than useless, because the user's next action is to try again and wait ten more minutes. So the
log is the product here, not a diagnostic afterthought.

**The build runs in the user's account, not ours.** CodeBuild was created by the bootstrap inside the
connected account with a bounded service role, which means the credentials that touch their
infrastructure are issued by AWS to their own project and never exist in our process. The alternative -
running `pulumi up` on our own workers with assumed credentials - would put a live session with
resource-creating permission in the memory of a multi-tenant service, and would make our worker's
concurrency the limit on how many users can deploy at once. Streaming someone else's build log is a
smaller problem than holding someone else's credentials.

**Reusing the existing stream.** #29 already provides a worker runtime, a `JobContext` with `log` and
`progress`, and an SSE route at `GET /experiments/:id/events` that replays from `Last-Event-ID`. This
issue adds a job handler that writes CloudWatch log lines into that context. Building a second
streaming path for build output would mean two reconnect implementations and two places for a proxy to
break.

**Lines are sanitised on the way in.** Build output is attacker-influenced: it contains repository
names, IR-derived strings, and AWS error messages. It is written to our log store and then rendered in
a browser, so control characters and ANSI escapes are stripped, and anything shaped like a credential
is redacted before storage rather than before display. The same reasoning that closed the log-injection
findings in the API applies with more force to text produced by a machine in someone else's account.

This issue is larger than one file's worth of work because the pieces cannot be usefully split: a
source bundle nobody uploads, a build nobody watches, and a log stream with no build to read are each
untestable alone, and every one of them exists only to make the other two work.

Spec: `docs/AWS.md`, `docs/DATABASE.md`

### Contract

```ts
// apps/api/src/lib/deploy/source-bundle.ts
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}
/**
 * Deterministic zip: entries sorted by path, mtime fixed to 1980-01-01T00:00:00Z,
 * mode 0644, no extra fields. The same files always produce the same sha256.
 */
export function buildSourceBundle(files: readonly GeneratedFile[]): {
  zip: Buffer;
  sha256: string;
};

// apps/api/src/lib/deploy/codegen-client.ts
export type CodegenResult =
  | { ok: true; files: GeneratedFile[] }
  | { ok: false; reason: 'validation_failed' | 'unsupported_type' | 'unavailable'; detail: string };
/** POST to the brain's /codegen/pulumi. A 422 is a failure, never a partial success. */
export function generateProject(
  experiment: Experiment,
  stateBucket: string
): Promise<CodegenResult>;

// apps/api/src/lib/deploy/sanitise.ts
/** Returns null for a line that should not be stored at all. */
export function sanitiseLogLine(raw: string): string | null;

// apps/api/src/lib/deploy/log-stream.ts
export interface LogCursor {
  readonly groupName: string;
  readonly streamName: string;
  readonly nextToken?: string;
}
/** One GetLogEvents call. Returns the advanced cursor and the sanitised lines. */
export function pollLogs(
  credentials: AwsCredentials,
  region: string,
  cursor: LogCursor
): Promise<{ cursor: LogCursor; lines: string[]; advanced: boolean }>;

// apps/api/src/lib/deploy/codebuild.ts
export type BuildOutcome = 'succeeded' | 'failed' | 'timed_out' | 'stopped' | 'fault';
export interface RunDeployInput {
  readonly credentials: AwsCredentials;
  readonly bootstrap: BootstrapOutputs;
  readonly experimentId: string;
  readonly stackName: string;
  readonly region: string;
  readonly sourceKey: string;
}
export interface DeployResult {
  readonly outcome: BuildOutcome;
  readonly buildId: string;
  readonly failedPhase: string | null;
  readonly stackOutputs: Record<string, unknown>;
  readonly linesStreamed: number;
}
/** Starts the build, streams until it reaches a terminal state, and records the result. */
export function runDeploy(input: RunDeployInput, ctx: JobContext): Promise<DeployResult>;
```

The handler, registered on the worker from #29 as kind `deploy.experiment`:

1. Load the experiment and its verified connection; refuse when the experiment is already `deploying`
   by taking `pg_advisory_xact_lock(hashtext(experiment_id))` and re-reading the status inside the same
   transaction, so two enqueued deploys cannot both start a build.
2. `assumeConnection(connectionId, 'deploy')`, then `ensureBootstrap`.
3. `generateProject`. On `validation_failed`, write each finding as a log line, mark the experiment
   `failed`, and return without starting a build.
4. `putArtifact` for every generated file with kind `pulumi_program`, so the artifact rows and the bytes
   in the bundle are the same bytes.
5. Upload the bundle to `s3://<stateBucket>/sources/<experimentId>/<sha256>.zip`, skipping the upload
   when that key already exists.
6. `StartBuild` on the bootstrap's project with `sourceLocationOverride` set to that key and
   environment overrides `PULUMI_COMMAND=up`, `EXPERIMENT_ID`, `PULUMI_BACKEND_URL`,
   `PULUMI_SECRETS_PROVIDER`, `PULUMI_STACK_NAME`, `STATE_BUCKET`, `PULUMI_VERSION`,
   `STALE_LOCK_MINUTES`.
7. Poll `BatchGetBuilds` every 2 seconds for phase and for `logs.groupName`, and `GetLogEvents` with
   `startFromHead: true` from the cursor. Map phases to progress fractions: `QUEUED` 0.1,
   `PROVISIONING` 0.2, `DOWNLOAD_SOURCE` 0.3, `INSTALL` 0.4, `PRE_BUILD` 0.5, `BUILD` 0.6 to 0.9,
   `POST_BUILD` 0.95, `COMPLETED` 1.
8. Stop when `buildComplete` is true and the forward token has stopped advancing, or at 65 minutes,
   which is past the project's own 60-minute timeout.
9. On success read `experiments/<id>/outputs.json` from the state bucket, cap it at 256KB, and
   `recordDeployment` with the account, region, stack name, build id, and outputs. On any other outcome
   record the failing phase and set the experiment `failed`.

`sanitiseLogLine` strips ANSI CSI sequences and every control character except tab, drops carriage
returns and newlines so one event cannot forge several log lines, truncates at 4096 characters with a
marker, and replaces matches of `(AKIA|ASIA)[0-9A-Z]{16}`, `aws_secret_access_key\s*=\s*\S+`, and
`x-amz-security-token:\s*\S+` with `[redacted]`. After `DEPLOY_LOG_MAX_LINES` (default 50000) it emits
one truncation notice and stops storing lines, while polling continues so the outcome is still recorded.

Route: `POST /experiments/:id/deploy` enqueues the job and returns 202 with the job id, or 409 when the
experiment is already deploying. The browser then reads `GET /experiments/:id/events`.

### Files

- CREATE `apps/api/src/lib/deploy/source-bundle.ts`
- CREATE `apps/api/src/lib/deploy/codegen-client.ts`
- CREATE `apps/api/src/lib/deploy/sanitise.ts`
- CREATE `apps/api/src/lib/deploy/log-stream.ts`
- CREATE `apps/api/src/lib/deploy/codebuild.ts`
- CREATE `apps/api/src/lib/jobs/handlers/deploy.ts`
- CREATE `apps/api/src/routes/experiments/deploy.ts`
- CREATE `apps/api/src/lib/deploy/source-bundle.test.ts`
- CREATE `apps/api/src/lib/deploy/sanitise.test.ts`
- CREATE `apps/api/src/lib/deploy/log-stream.test.ts`
- CREATE `apps/api/src/lib/deploy/codebuild.test.ts`
- CREATE `apps/api/src/lib/jobs/handlers/deploy.integration.test.ts`
- CREATE `apps/api/src/lib/deploy/__fixtures__/batch-get-builds-progress.json`
- CREATE `apps/api/src/lib/deploy/__fixtures__/batch-get-builds-failed.json`
- CREATE `apps/api/src/lib/deploy/__fixtures__/get-log-events-paged.json`
- MODIFY `apps/api/package.json` - add `@aws-sdk/client-codebuild`,
  `@aws-sdk/client-cloudwatch-logs`, `@aws-sdk/client-s3`, and `jszip`
- MODIFY `apps/api/src/lib/env.ts` - add `BRAIN_URL` and `DEPLOY_LOG_MAX_LINES`
- MODIFY `apps/api/src/index.ts` - register the handler and mount the route

### Acceptance Criteria

- [ ] The same generated files always produce a bundle with the same sha256, across processes and days
- [ ] A validation failure from the brain records the findings and starts no build
- [ ] Two deploys enqueued for one experiment result in one build, and the second returns 409
- [ ] Log lines reach the SSE stream while the build is still running, not only at the end
- [ ] A carriage return or newline inside a CloudWatch event cannot produce two stored log lines
- [ ] An `AKIA`-prefixed access key id in build output is stored as `[redacted]`
- [ ] Paginated log output is read to the end with no duplicated and no skipped events
- [ ] A build that fails records the failing phase and leaves the experiment `failed`
- [ ] A build exceeding 65 minutes of polling is abandoned with `timed_out` recorded
- [ ] A successful build stores the parsed stack outputs on the deployment row
- [ ] Every generated file is stored as a `pulumi_program` artifact before the build starts

### Required Tests

- `bundle sha256 is stable for identical files`
- `bundle entry order and timestamps are fixed`
- `a validation failure records findings and starts no build`
- `a second concurrent deploy is refused`
- `log lines are emitted while the build is in progress`
- `a newline inside an event cannot forge a second log line`
- `an access key id in build output is redacted`
- `paginated log reads neither duplicate nor skip events`
- `a failed build records the failing phase`
- `a stalled build is abandoned after the timeout`
- `stack outputs are parsed and recorded on success`

### Performance Budget

p95 lag from a line being available in CloudWatch to it reaching the SSE stream is under 3 seconds,
which follows from a 2-second poll interval plus one round trip; measured in the integration test by
comparing event ingestion timestamps against stored log timestamps. At most one `GetLogEvents` and one
`BatchGetBuilds` call per 2 seconds per active build. Heap held per streamed build stays under 2MB,
enforced by the 1000-event page limit and the 4096-character line cap.

### Out of Scope

- Do not build a second streaming transport; the SSE route from #29 is the only one
- Do not run `pulumi up` on the API host or in a worker container
- Do not pass assumed credentials into the build; CodeBuild uses its own bounded service role
- Do not implement destroy; that is `docs/issues/epic-9-deploy/040-one-click-destroy.md`
- Do not add cost estimation to this path; the estimate comes from the prediction epic
- Do not retry a failed build automatically, which would double a partial deploy's blast radius

### Dependencies

Blocked by #27 for the deployment and artifact rows, #28 for the queue, and #29 for the worker and the
SSE stream. Also blocked by `docs/issues/epic-9-deploy/010-cross-account-role-connect.md`,
`docs/issues/epic-9-deploy/020-bootstrap-stack.md`, and the generation endpoint in
`docs/issues/epic-8-codegen/030-generated-code-validation.md`.

### Verification

```bash
pnpm --filter @infracanvas/api test
docker compose --profile aws up -d localstack
AWS_ENDPOINT_URL=http://localhost:4566 pnpm --filter @infracanvas/api test:integration
curl -s -X POST localhost:3001/experiments/$ID/deploy
curl -N -H 'Accept: text/event-stream' localhost:3001/experiments/$ID/events
```

Testing without a real AWS account: CodeBuild is not available in LocalStack's community edition, so
`StartBuild`, `BatchGetBuilds` and `GetLogEvents` are driven with `aws-sdk-client-mock` replaying
fixtures captured from one real sandbox build - the full phase sequence, a three-page log stream, a
`FAILED` outcome mid-`BUILD`, and a stream that stops advancing before `buildComplete`. S3 upload,
skip-if-present, and `outputs.json` retrieval run against LocalStack's S3. The integration test drives
the real worker and the real SSE route against Postgres, so streaming and reconnection are exercised
with a mocked AWS rather than a mocked stream. One end-to-end deploy in the sandbox account is on the
manual pre-release checklist, because nothing local proves that the buildspec's `pulumi login` line and
the deploy role's four S3 permissions actually agree.

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:l - over 600 lines
