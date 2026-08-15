---
title: '[api] Remove the long-lived AWS keys the deployment model forbids'
labels: tier:1, size:s, area:api, epic:1-data
---

### Epic

#2

### Context

`docs/issues/epic-9-deploy/010-cross-account-role-connect.md` states the rule the deployment design
rests on, and states it twice for emphasis: _"No long-lived keys, ever"_, and _"The schema below has
no column an access key could be written to."_ The database keeps that promise. The process does not.

`apps/api/src/lib/env.ts` declares `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in its environment
type and reads both out of `process.env` in two places. Nothing in `apps/api` consumes them. They are
inert today and they are a place for a key to live, which is the thing the rule forbids: the argument
in that spec is not that keys are unused, it is that there is nowhere to put one, so nobody can be
persuaded to put one there.

Two consequences make this worth closing before Phase 7 rather than during it.

The first is that a declared environment variable is a documented one. `apps/api/.env.example` is what
an operator copies, and a name appearing in the environment schema reads as a supported way to give
the service AWS access. An operator who sets them gets a process holding standing credentials to their
account, with no expiry, no external ID, no permission boundary, and no `sts:SourceIdentity` — none of
the properties the connect design exists to provide.

The second is that the AWS SDK reads those two variables from the ambient environment on its own,
through the default credential provider chain, whether or not `env.ts` mentions them. So declaring
them buys nothing even for a caller that wanted them, while removing them does not break any code path
that legitimately uses the chain. `services/brain`'s Bedrock provider is specified to authenticate
that way — through the ambient chain rather than a stored key — and is unaffected.

There is one honest caveat. Removing a variable from a validated schema is a behaviour change if the
schema rejects unknown keys. It does not: `env.ts` reads named properties off `process.env`, so an
operator who has set them will simply find them ignored. That is the intended outcome and it should be
stated in the changelog rather than discovered.

Spec: `docs/issues/epic-9-deploy/010-cross-account-role-connect.md`

### Contract

```typescript
// apps/api/src/lib/env.ts
//
// There is no environment variable through which this process can be given
// standing access to an AWS account. Deployment credentials are obtained per
// operation by assuming a role the customer created, with an external id and a
// permissions boundary, and they expire.
export interface Env {
  // AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are deliberately absent.
}
```

After this issue, a search of `apps/api/src` for either name returns only the comment above and the
test that asserts their absence.

### Files

- `apps/api/src/lib/env.ts` — MODIFY: remove both properties from the interface and both reads from
  the two construction sites; add the comment stating why there is no such variable.
- `apps/api/src/lib/env.test.ts` — MODIFY: add the absence assertions below.
- `apps/api/.env.example` — MODIFY: remove both entries if present, and say in a comment that AWS
  access is obtained by assuming a role rather than by configuration.
- `docs/issues/epic-9-deploy/010-cross-account-role-connect.md` — MODIFY: note that the environment
  schema was cleared, so the spec's claim is true of the whole service rather than only its database.

### Acceptance Criteria

- [ ] Neither variable appears in the environment type or is read from `process.env` in `apps/api`.
- [ ] Setting both in the environment changes no behaviour and produces no warning at boot.
- [ ] `apps/api/.env.example` does not mention them.
- [ ] The API starts from a clean environment exactly as before.
- [ ] A test fails if either name is reintroduced into `apps/api/src/lib/env.ts`.

### Required Tests

- `the environment schema has no aws key fields` — asserts the parsed environment object has no
  `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` property, with both set in `process.env` during the
  test so the assertion is about the schema rather than about the ambient environment being empty.
- `setting aws keys does not change the parsed environment` — parses with and without both set and
  asserts the two results are deeply equal, which is the observable form of "ignored".
- `env.ts contains no reference to a long-lived aws credential` — reads `env.ts` as text and asserts
  neither name appears outside a comment. Crude, and it is the assertion that survives someone adding
  the field back in a hurry.
- The existing environment tests must pass unchanged, in particular that a missing required variable
  still refuses to boot.

### Performance Budget

n/a

### Out of Scope

- Building the cross-account role, the external id, the permissions boundary or `sts:SourceIdentity`.
  All belong to Epic 9; this issue only removes the alternative to them.
- `services/brain`'s credential handling, which uses the ambient chain by design.
- `ENCRYPTION_KEY` rotation or key versioning.
- Any other entry in the environment schema.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/api exec vitest run src/lib/env.test.ts
pnpm --filter @infracanvas/api exec tsc --noEmit
grep -rn "AWS_ACCESS_KEY_ID\|AWS_SECRET_ACCESS_KEY" apps/api/src apps/api/.env.example
```

The grep must return only the explanatory comment and the guard test. Then confirm the service still
boots with both set, and behaves identically:

```bash
AWS_ACCESS_KEY_ID=unused AWS_SECRET_ACCESS_KEY=unused pnpm --filter @infracanvas/api dev
curl -fsS localhost:3001/health
```
