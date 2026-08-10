---
title: '[infra] Connect an AWS account with a cross-account role and an external ID'
labels: tier:1, size:m, area:infra, epic:9-deploy
---

### Epic

#10

### Context

This is the first thing a user does that hands us power over something expensive, and the last place
where a shortcut stays cheap. Everything the deploy epic does afterwards runs on the credentials this
issue produces.

**No long-lived keys, ever.** The obvious implementation is a form with an access key id and a secret,
encrypted with `apps/api/src/lib/encryption.ts` the way GitHub tokens already are. It was rejected.
A GitHub token can be revoked from a settings page and its blast radius is a repository; an IAM user's
access key is a permanent credential to an account that can be charged, it is usually created with more
permission than needed because that is what the console suggests, and if our database leaks then every
connected account is compromised with no expiry to wait for. A cross-account role instead means we hold
nothing worth stealing: we call `sts:AssumeRole` when we need credentials, get something that expires
in an hour, and the user revokes us by deleting one role. The schema below has no column an access key
could be written to, which is the only version of this rule that survives a future contributor in a
hurry.

**Why the external ID exists, concretely.** The role's trust policy has to name a principal it will
let in, and that principal is our deploy role - one ARN, shared by every user of the platform. So our
service is a deputy that many parties can ask to act. A role ARN is not a secret: it contains a
12-digit account id and a role name we document, it appears in CloudTrail and in support tickets, and
it is guessable. Without a second condition, anyone could sign up, enter someone else's role ARN, and
have us assume it for them - we would be the confused deputy, using our own trusted identity to do
something on behalf of a party who has no right to it. The external ID closes that: the trust policy
requires `sts:ExternalId` to equal a value only we and the account's owner know, so possession of the
role ARN alone is worth nothing. The check is evaluated by AWS inside the user's account, which is why
it holds even if our own authorisation code has a bug.

That reasoning only works if the external ID is unguessable and per-connection, so it is 32 bytes from
`randomBytes` rendered base64url, generated server-side and never accepted from the client. A
user-chosen value would eventually be `infracanvas`, and a value shared across connections would let
one tenant's leak be another tenant's problem.

**Tier routing.** Gate 7 derives risk tier from paths, and `apps/api/src/lib/aws/` is not in its
tier-1 list, so the code in this issue would merge as tier 2 without a security review. The list is
extended here, in the same pull request that creates the paths.

Spec: `docs/DATABASE.md`, `docs/DELIVERY.md`

### Contract

```sql
CREATE TYPE aws_connection_status AS ENUM ('pending', 'verified', 'failed', 'revoked');

CREATE TABLE aws_connections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  aws_account_id text NOT NULL CHECK (aws_account_id ~ '^[0-9]{12}$'),
  role_arn       text NOT NULL CHECK (role_arn ~ '^arn:aws:iam::[0-9]{12}:role/.+$'),
  -- AES-256-GCM ciphertext from apps/api/src/lib/encryption.ts. There is deliberately
  -- no column for an access key id or a secret access key.
  external_id_encrypted text NOT NULL,
  default_region text NOT NULL,
  status         aws_connection_status NOT NULL DEFAULT 'pending',
  last_verified_at timestamptz,
  -- A message safe to show the user. Never an SDK error body.
  failure_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- The role must live in the account it claims to.
  CHECK (role_arn LIKE 'arn:aws:iam::' || aws_account_id || ':role/%'),
  UNIQUE (user_id, role_arn)
);

CREATE INDEX aws_connections_user_idx ON aws_connections (user_id, created_at DESC);

CREATE TRIGGER aws_connections_updated_at
  BEFORE UPDATE ON aws_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

```ts
// apps/api/src/lib/aws/external-id.ts
/** 32 bytes of CSPRNG, base64url. Never derived from user input. */
export function generateExternalId(): string;

// apps/api/src/lib/aws/trust-policy.ts
export function renderTrustPolicy(externalId: string): string;

// apps/api/src/lib/aws/assume-role.ts
export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}
export type AssumeFailure =
  | 'trust_policy_missing_platform'
  | 'external_id_mismatch'
  | 'role_not_found'
  | 'region_denied'
  | 'unavailable';
/** Never persists the returned credentials. */
export function assumeConnection(
  connectionId: string,
  purpose: 'verify' | 'bootstrap' | 'deploy' | 'destroy' | 'reap'
): Promise<{ ok: true; credentials: AwsCredentials } | { ok: false; reason: AssumeFailure }>;

// apps/api/src/lib/db/aws-connections.ts
export function beginConnection(input: {
  userId: string;
  awsAccountId: string;
  roleArn: string;
  region: string;
}): Promise<{ connection: AwsConnection; externalId: string; trustPolicy: string }>;
export function verifyConnection(id: string, userId: string): Promise<AwsConnection>;
export function revokeConnection(id: string, userId: string): Promise<void>;
export function getVerifiedConnection(id: string, userId: string): Promise<AwsConnection>;
```

The trust policy handed to the user, rendered with the platform's own role from configuration:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InfraCanvasAssume",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<INFRACANVAS_AWS_ACCOUNT_ID>:role/infracanvas-deployer" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "sts:ExternalId": "<external id>" },
        "Bool": { "aws:SecureTransport": "true" }
      }
    }
  ]
}
```

Routes, all requiring a session and scoped to the requesting user:

| Route                              | Behaviour                                                              |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `POST /aws/connections`            | Creates a `pending` row, returns the external ID and trust policy once |
| `POST /aws/connections/:id/verify` | Assumes the role, records `verified` or `failed` with a safe reason    |
| `GET /aws/connections`             | Lists the user's connections without the external ID                   |
| `DELETE /aws/connections/:id`      | Marks `revoked`; does not delete the row, so audit history survives    |

`assumeConnection` calls `AssumeRole` with `RoleSessionName` `infracanvas-<purpose>-<id first 8>`,
`DurationSeconds: 3600`, and the decrypted external ID. The external ID is returned to the client only
by `POST /aws/connections`, because the user has to paste it into a trust policy; every later response
omits it, and no code path logs it.

### Files

- CREATE `db/migrations/<timestamp>_aws_connections.sql`
- CREATE `apps/api/src/lib/aws/external-id.ts`
- CREATE `apps/api/src/lib/aws/trust-policy.ts`
- CREATE `apps/api/src/lib/aws/assume-role.ts`
- CREATE `apps/api/src/lib/db/aws-connections.ts`
- CREATE `apps/api/src/routes/aws/connections.ts`
- CREATE `apps/api/src/lib/aws/external-id.test.ts`
- CREATE `apps/api/src/lib/aws/trust-policy.test.ts`
- CREATE `apps/api/src/lib/aws/assume-role.test.ts`
- CREATE `apps/api/src/lib/db/aws-connections.integration.test.ts`
- MODIFY `apps/api/package.json` - add `@aws-sdk/client-sts` and the `aws-sdk-client-mock` dev
  dependency
- MODIFY `apps/api/src/lib/env.ts` - add `INFRACANVAS_AWS_ACCOUNT_ID`, `INFRACANVAS_DEPLOYER_ROLE_NAME`,
  and the optional `AWS_ENDPOINT_URL` used to point tests at LocalStack
- MODIFY `apps/api/src/index.ts` - mount the connections router
- MODIFY `apps/api/.env.example` - document the new variables
- MODIFY `docker-compose.yml` - add LocalStack under a `aws` profile on port 4566
- MODIFY `.github/workflows/gate-review.yml` - add `apps/api/src/lib/aws/` and
  `apps/api/src/routes/aws/` to the tier-1 path expression

### Acceptance Criteria

- [ ] The `aws_connections` table has no column capable of storing an access key, and the migration
      applies, rolls back, and reapplies
- [ ] A role ARN whose embedded account id differs from `aws_account_id` is rejected by the database
- [ ] Two `generateExternalId` calls never collide, and the value is at least 32 bytes of entropy
- [ ] An external ID supplied in the `POST /aws/connections` body is ignored, not honoured
- [ ] The rendered trust policy contains a `StringEquals` condition on `sts:ExternalId`
- [ ] `verifyConnection` marks the connection `failed` with a user-safe reason when the assume is
      denied, and never stores the raw SDK error
- [ ] Credentials from `assumeConnection` are returned to the caller and written nowhere, including
      logs and the database
- [ ] The external ID never appears in any response after creation, in any log line, or in an error
      body
- [ ] A user cannot verify, read, or revoke another user's connection; the response is 404, not 403
- [ ] A revoked connection cannot be assumed, and `getVerifiedConnection` refuses it

### Required Tests

- `rejects a role arn whose account differs from the account id`
- `ignores an external id supplied by the client`
- `generates distinct high entropy external ids`
- `trust policy pins the external id and the platform principal`
- `records a safe failure reason when the assume is denied`
- `never logs the external id or the session credentials`
- `does not persist temporary credentials`
- `refuses to assume a revoked connection`
- `returns 404 for another user's connection`
- `cascades connection deletion when the user is deleted`

### Performance Budget

`POST /aws/connections/:id/verify` completes in under 2 seconds, dominated by the `AssumeRole` round
trip, with the SDK configured for 2 attempts and a 5-second request timeout so a hung STS endpoint
cannot occupy a request slot. Credential fetches are not cached in this issue; a deploy performs one
assume per operation.

### Out of Scope

- Do not accept, store, or offer a code path for access keys, even behind a configuration flag
- Do not implement external ID rotation; revoking and reconnecting produces the same result without a
  second code path
- Do not create the bootstrap resources or the deploy role; that is
  `docs/issues/epic-9-deploy/020-bootstrap-stack.md`
- Do not touch `apps/api/src/lib/auth/` or `github_tokens`; GitHub credentials are unrelated
- Do not add a UI; the web flow is tracked in the web epic

### Dependencies

Blocked by nothing still open. It builds on the `users` table and encryption helpers from #22, which has
landed, and everything else in this epic is blocked by it.

### Verification

```bash
pnpm db:migrate
dbmate --migrations-dir db/migrations rollback && dbmate --migrations-dir db/migrations up
pnpm --filter @infracanvas/api test
docker compose --profile aws up -d localstack
AWS_ENDPOINT_URL=http://localhost:4566 pnpm --filter @infracanvas/api test:integration
psql "$DATABASE_URL" -c "\d+ aws_connections"
```

Testing without a real AWS account: `AssumeRole` against LocalStack's STS on port 4566 covers the
success path and the shape of the credentials. LocalStack does not evaluate trust policies faithfully,
so the denial paths - a missing platform principal, a mismatched external ID, a deleted role - are
driven with `aws-sdk-client-mock` returning the real error codes captured from a sandbox account
(`AccessDenied`, `NoSuchEntity`, `ExpiredToken`). The claim that the trust policy actually permits only
the intended principal is checked with `iam:SimulatePrincipalPolicy` in the sandbox account as part of
the manual pre-release checklist, because a policy simulator needs a real IAM evaluation engine and no
local emulator provides one.

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
