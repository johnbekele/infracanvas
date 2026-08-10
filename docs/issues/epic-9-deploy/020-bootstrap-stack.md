---
title: '[infra] One-time bootstrap providing CodeBuild, state bucket, and a bounded deploy role'
labels: tier:1, size:m, area:infra, epic:9-deploy
---

### Epic

#10

### Context

A connected account cannot yet run anything. Deploys need somewhere to keep Pulumi state, somewhere to
execute, and an identity to execute as. Creating those on every deploy would be slow and would leave a
trail of half-made scaffolding when a deploy failed, so they are created once per account and region by
a bootstrap that is idempotent and inspectable.

**CloudFormation, not Pulumi.** Using our own generator here is circular: Pulumi's self-managed backend
needs the state bucket that the bootstrap creates, so the bootstrap cannot keep its state in the thing
it is bootstrapping. There are two ways out - keep bootstrap state in our database, or use a mechanism
that stores its own state in the user's account. CloudFormation does the second, which matters more
than the language: the user can open one console page and see exactly what we created, and delete all
of it in one action without our cooperation. A record of what we did to someone's account that only
exists in our database is not a record they can act on.

**The permission boundary is the actual security control.** The deploy role has to create Lambda
functions, buckets, tables, queues and the IAM roles those need, and a role that can create IAM roles
can escalate to administrator unless something stops it. An attached policy cannot stop that, because
the role could attach a wider policy to a role it creates. A permissions boundary can: it is evaluated
in addition to every policy on every role that carries it, so the ceiling holds even for identities the
deploy role invents. This is why the boundary also forbids removing or replacing itself.

**What the connect role needs, published rather than assumed.** Applying this stack requires
CloudFormation, S3, KMS, IAM and CodeBuild permissions in the user's account, which is more than the
deploy role will ever hold. Rather than telling users to attach `AdministratorAccess` - which is what
they will do if we say nothing - the exact policy is checked into the repository and documented, so a
cautious user can read it and a careful one can diff it.

Spec: `docs/AWS.md`

### Contract

`infra/bootstrap/template.yaml`, stack name `infracanvas-bootstrap`, one per account and region:

| Logical id          | Type                      | Notes                                                                                                       |
| ------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `StateKey`          | `AWS::KMS::Key`           | Rotation enabled; used for bucket SSE and as Pulumi's `awskms://` secrets provider                          |
| `StateKeyAlias`     | `AWS::KMS::Alias`         | `alias/infracanvas-state`                                                                                   |
| `StateBucket`       | `AWS::S3::Bucket`         | `infracanvas-state-${AWS::AccountId}-${AWS::Region}`, versioned, SSE-KMS, all four public-access flags true |
| `StateBucketPolicy` | `AWS::S3::BucketPolicy`   | Denies `s3:*` when `aws:SecureTransport` is false                                                           |
| `DeployBoundary`    | `AWS::IAM::ManagedPolicy` | The ceiling described below                                                                                 |
| `DeployRole`        | `AWS::IAM::Role`          | Trusted by `codebuild.amazonaws.com` only, with `PermissionsBoundary: !Ref DeployBoundary`                  |
| `DeployPolicy`      | `AWS::IAM::ManagedPolicy` | The grants the supported resource types need, attached to `DeployRole`                                      |
| `BuildLogGroup`     | `AWS::Logs::LogGroup`     | `/infracanvas/deploy`, `RetentionInDays: 30`                                                                |
| `BuildProject`      | `AWS::CodeBuild::Project` | `infracanvas-deploy`, `standard:7.0`, `BUILD_GENERAL1_SMALL`, 60-minute timeout, S3 source                  |

Parameters and outputs:

```yaml
Parameters:
  TemplateVersion:
    Type: Number
    Description: Bumped whenever this template changes, so the API can detect an outdated bootstrap.
  EnableBuildProject:
    Type: String
    AllowedValues: ['true', 'false']
    Default: 'true'
    Description: >
      CI applies this template against LocalStack, which does not implement CodeBuild.
      Production always passes true.
Conditions:
  CreateBuildProject: !Equals [!Ref EnableBuildProject, 'true']
Outputs:
  StateBucketName: ...
  StateKeyAliasArn: ...
  DeployRoleArn: ...
  DeployBoundaryArn: ...
  BuildProjectName: ...
  BootstrapTemplateVersion: ...
```

The deploy role's state access is exactly the four actions Pulumi's S3 backend uses -
`s3:ListBucket`, `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` - scoped to
`arn:aws:s3:::<bucket>/experiments/*` plus read on `sources/*`, and nothing else on that bucket.

`DeployBoundary` allows the service actions for the supported resource types and then denies, with no
condition that can be talked around:

```yaml
- Effect: Deny
  Action:
    - 'iam:CreateUser'
    - 'iam:CreateAccessKey'
    - 'iam:CreateLoginProfile'
    - 'iam:AttachUserPolicy'
    - 'iam:DeleteRolePermissionsBoundary'
    - 'organizations:*'
    - 'account:*'
    - 'ce:*'
    - 'sts:AssumeRole'
  Resource: '*'
- Effect: Deny
  Action: 'iam:PutRolePermissionsBoundary'
  Resource: '*'
  Condition:
    StringNotEquals:
      'iam:PermissionsBoundary': !Ref DeployBoundary
- Effect: Deny
  Action: '*'
  Resource: '*'
  Condition:
    StringNotEquals:
      'aws:RequestedRegion': !Ref 'AWS::Region'
- Effect: Deny
  NotAction: ['iam:*', 's3:ListBucket', 'logs:*', 'kms:*']
  Resource: '*'
  Condition:
    'Null':
      'aws:RequestTag/infracanvas:experiment-id': 'true'
```

The last statement is the tagging guarantee the reaper depends on, and it is deliberately partial: not
every AWS API accepts tags on create, so the emitters tag everything they can and
`docs/issues/epic-9-deploy/040-one-click-destroy.md` sweeps for what slips through. Claiming the
boundary alone guarantees full tag coverage would be false.

```ts
// apps/api/src/lib/aws/bootstrap.ts
export const BOOTSTRAP_TEMPLATE_VERSION = 1;
export const BOOTSTRAP_STACK_NAME = 'infracanvas-bootstrap';

export interface BootstrapOutputs {
  readonly stateBucketName: string;
  readonly stateKeyAliasArn: string;
  readonly deployRoleArn: string;
  readonly deployBoundaryArn: string;
  readonly buildProjectName: string;
  readonly templateVersion: number;
}

export type BootstrapState =
  | 'missing'
  | 'outdated'
  | 'current'
  | 'rollback_complete'
  | 'in_progress';

export function readBootstrap(
  credentials: AwsCredentials,
  region: string
): Promise<{ state: BootstrapState; outputs: BootstrapOutputs | null }>;

/** Creates or updates, waits for a terminal state, and is safe to call on every deploy. */
export function ensureBootstrap(
  credentials: AwsCredentials,
  region: string
): Promise<BootstrapOutputs>;
```

`ensureBootstrap` calls `CreateStack` with `Capabilities: ['CAPABILITY_NAMED_IAM']`, falls back to
`UpdateStack` on `AlreadyExistsException`, treats `No updates are to be performed` as success, deletes
a stack sitting in `ROLLBACK_COMPLETE` before retrying once, and returns the failing status reason
otherwise. Route: `POST /aws/connections/:id/bootstrap` returns the outputs, or 409 while another apply
is in progress.

### Files

- CREATE `infra/bootstrap/template.yaml`
- CREATE `infra/bootstrap/connect-role-policy.json` - the policy a user attaches to the role we assume
- CREATE `apps/api/src/lib/aws/bootstrap.ts`
- CREATE `apps/api/src/routes/aws/bootstrap.ts`
- CREATE `apps/api/src/lib/aws/bootstrap.test.ts`
- CREATE `apps/api/src/lib/aws/boundary.test.ts` - assertions over the parsed boundary statements
- CREATE `apps/api/src/lib/aws/bootstrap.integration.test.ts` - applies the template to LocalStack
- CREATE `docs/AWS.md` - what the bootstrap creates, what the connect policy grants, how to remove both
- MODIFY `apps/api/package.json` - add `@aws-sdk/client-cloudformation` and the `yaml` dev dependency
- MODIFY `apps/api/src/index.ts` - mount the bootstrap route
- MODIFY `services/brain/pyproject.toml` - add `cfn-lint` to the dev extra, which is where this
  repository keeps Python linters

### Acceptance Criteria

- [ ] `ensureBootstrap` on an account with no stack creates it and returns all six outputs
- [ ] `ensureBootstrap` called twice in a row makes no changes the second time and still returns outputs
- [ ] `readBootstrap` reports `outdated` when the deployed `TemplateVersion` is below the code's
- [ ] A stack in `ROLLBACK_COMPLETE` is deleted and recreated rather than reported as present
- [ ] A second concurrent apply returns 409 rather than racing CloudFormation
- [ ] `DeployRole` can be assumed by `codebuild.amazonaws.com` and by no other principal
- [ ] `DeployRole` carries the permissions boundary, and the boundary denies `iam:CreateAccessKey`
- [ ] The boundary denies every action outside the bootstrap's own region
- [ ] The state bucket denies non-TLS requests and blocks all four forms of public access
- [ ] The deploy role's bucket grants are limited to the four actions Pulumi's S3 backend uses
- [ ] `cfn-lint` and `checkov --framework cloudformation` pass over the template with no findings

### Required Tests

- `creates the stack and returns every output`
- `a second apply reports no changes`
- `reports an outdated template version`
- `recreates a stack stuck in rollback complete`
- `refuses a concurrent apply with a conflict`
- `deploy role trusts only codebuild`
- `boundary denies access key creation and boundary removal`
- `boundary denies actions outside the bootstrap region`
- `state bucket denies plaintext transport and public access`
- `deploy role has no s3 action beyond list get put and delete`

### Performance Budget

A first-time `ensureBootstrap` completes in under 180 seconds, which is CloudFormation's own pace for a
KMS key and a CodeBuild project; the API polls stack events every 5 seconds and gives up at 600. A
no-op `ensureBootstrap` completes in under 3 seconds, because it runs before every deploy.

### Out of Scope

- Do not generate this template from the Pulumi emitter; the state bucket it creates is what that
  emitter's projects depend on
- Do not create per-experiment buckets, roles, or projects; those are prefixes and tags inside these
- Do not start builds here; that is `docs/issues/epic-9-deploy/030-codebuild-deploy-with-log-stream.md`
- Do not add a console "Launch Stack" URL as a second path to the same resources
- Do not widen `connect-role-policy.json` to `AdministratorAccess` to make a test pass

### Dependencies

Blocked by #22 for the `users` table the connection rows hang from, and by
`docs/issues/epic-9-deploy/010-cross-account-role-connect.md` for the credentials this applies with.

### Verification

```bash
uv run --directory services/brain cfn-lint infra/bootstrap/template.yaml
uv run --directory services/brain checkov -f infra/bootstrap/template.yaml --framework cloudformation
pnpm --filter @infracanvas/api test
docker compose --profile aws up -d localstack
AWS_ENDPOINT_URL=http://localhost:4566 pnpm --filter @infracanvas/api test:integration
```

Testing without a real AWS account: the template is applied against LocalStack with
`EnableBuildProject=false`, which covers stack creation, the bucket, the KMS alias, the IAM role and
boundary, idempotent reapply, and the `ROLLBACK_COMPLETE` recovery path. `cfn-lint` and checkov's
CloudFormation framework check the template statically, including the CodeBuild resource LocalStack
cannot create. The boundary's statements are asserted structurally from the parsed YAML, which proves
they are present but not that AWS evaluates them as intended; that is verified once per release by
running `iam:SimulateCustomPolicy` against the sandbox account for the denied actions listed in the
acceptance criteria, together with one full apply including CodeBuild. Both are on the manual
pre-release checklist in `docs/AWS.md`.

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
