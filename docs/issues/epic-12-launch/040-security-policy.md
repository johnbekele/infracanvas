---
title: '[api] Security policy, threat model, and a checkable no-egress promise'
labels: tier:3, size:m, area:api, epic:12-launch
---

### Epic

#13

### Context

The reason to self-host this tool is that it holds credentials which open a cloud account and a source
repository. A user weighing that decision needs three things: somewhere to report a vulnerability, a
written account of what the system protects and what it does not, and a promise about secrets that is
narrow enough to be tested. The first two are documents. The third is only worth writing if CI can fail
when it stops being true, because "we never send your secrets anywhere" is otherwise a sentence, and
sentences do not survive refactors.

So the promise is stated as three checkable claims rather than one unfalsifiable one. Credentials are
only ever sent to the host they authenticate to, which is checked by an allowlist over outbound request
hosts and a rule that any request carrying an `Authorization` header must target a host in
`CREDENTIAL_HOSTS`. Credentials never appear in a response body or a log line, which is checked by
seeding a canary value through every credential path and asserting it appears in neither. And there is no
telemetry, which is checked against the lockfile rather than promised in prose.

Static allowlisting was chosen over an outbound proxy. A proxy is stronger, because it catches egress the
source never mentions, but it only protects the environments that run it, and a self-hoster who starts the
services with `pnpm dev` has no proxy. A check that fails in CI when a new outbound host appears in the
source protects every deployment, including the ones nobody configured. The threat model states this
limitation rather than implying the check is a sandbox.

The threat model is written per trust boundary and each boundary either names its mitigation or links the
open issue that will provide one. A model with no gaps is a model that stopped looking, so the document
also states what it deliberately does not defend against: a Postgres that the operator exposes to the
internet, a malicious dependency in the tree, a GitHub token already compromised elsewhere, and a
self-hoster who runs the API and the browser on hosts they do not control.

The reporting channel is GitHub's private vulnerability reporting rather than an email address, because
this is a solo-maintainer repository: an address needs somebody to watch it, and an unwatched security
address is worse than none. The policy states the acknowledgement and disclosure windows a solo maintainer
can actually meet, and says plainly that there is no bounty.

Spec: `docs/DELIVERY.md`

### Contract

`SECURITY.md` at the repository root, with these sections and no others:

```
Supported versions        - `main` only, with the reason: there are no release branches
Reporting a vulnerability - GitHub private vulnerability reporting, with the direct link
Response windows          - acknowledgement within 72 hours, fix or public advisory within 90 days
In scope                  - this repository, generated infrastructure code, generated workflows
Out of scope              - a self-hoster's own AWS account, third-party services, dependency CVEs
                            without a demonstrated path through this code
No bounty                 - stated plainly, with credit in the advisory offered instead
```

`docs/THREAT_MODEL.md`:

```
Assets            - GitHub token, AWS credentials, model API keys, repository contents,
                    embeddings, generated infrastructure code
Where each lives  - table: asset, store, encryption at rest, which process reads it
Trust boundaries  - browser to API, API to Postgres, API to GitHub, API to AWS,
                    API to model provider, generated pull request to the target repository CI,
                    load-test runner task to the deployed target
Per boundary      - what an attacker gains, the mitigation in place, or the open issue for the gap
Explicit non-goals- operator-exposed Postgres, malicious dependencies, an already-compromised token,
                    an untrusted host running the API
```

```javascript
// scripts/ci/check-egress-allowlist.mjs
/**
 * Fails when the source gains an outbound host that the policy does not list, or
 * sends an Authorization header to a host outside CREDENTIAL_HOSTS.
 */
export const ALLOWED_HOSTS = ['api.github.com', 'github.com'];
export const CREDENTIAL_HOSTS = ['api.github.com'];

export function findOutboundHosts(sourceRoot) /* : { host: string, file: string, line: number }[] */;
export function validate(hosts) /* : string[] */;
```

Hosts reached through the AWS SDK and configured model providers are resolved from the SDK client
configuration rather than from literals, and are listed in the policy with the environment variable that
sets them.

```typescript
// apps/api/src/lib/security/no-secret-egress.integration.test.ts
/** A value that appears in no fixture, so any occurrence is a leak rather than a coincidence. */
export const CANARY = 'ic-canary-9f3b7c2e-do-not-log';
```

The canary is installed as the GitHub token, the AWS secret access key, and the model API key for the
duration of the test; every route is exercised; and the assertion is that the canary appears in no
response body, no captured log line, and no request to a host outside `CREDENTIAL_HOSTS`, with outbound
requests captured by an undici mock agent that fails the test on an unexpected host.

### Files

- CREATE `SECURITY.md`
- CREATE `docs/THREAT_MODEL.md`
- CREATE `scripts/ci/check-egress-allowlist.mjs`
- CREATE `apps/api/src/lib/security/canary.ts`
- CREATE `apps/api/src/lib/security/no-secret-egress.integration.test.ts`
- CREATE `scripts/ci/check-no-telemetry.mjs` - asserts the lockfile has no analytics or telemetry package
- MODIFY `.github/workflows/gate-security.yml` - run both checks on every pull request

### Acceptance Criteria

- [ ] `SECURITY.md` names a reporting channel that exists, an acknowledgement window, and a disclosure window
- [ ] `docs/THREAT_MODEL.md` names every credential the system holds, where it is stored, and which process reads it
- [ ] Every trust boundary listed carries either a mitigation or a link to the issue that will provide one
- [ ] The threat model states what it does not defend against, including a Postgres exposed by the operator
- [ ] The threat model states that the egress check is a source-level check and not a runtime sandbox
- [ ] The canary value appears in no API response body and no log line
- [ ] The canary value is sent only to hosts in `CREDENTIAL_HOSTS`; any other outbound host fails the test
- [ ] `check-egress-allowlist.mjs` fails when a new outbound host appears in the source
- [ ] `check-egress-allowlist.mjs` fails when a request carrying an `Authorization` header targets a host outside `CREDENTIAL_HOSTS`
- [ ] `check-no-telemetry.mjs` fails when an analytics or telemetry package enters the lockfile
- [ ] Gate 5 runs both checks, so the promise is retested on every pull request

### Required Tests

- `the canary token never appears in an api response body`
- `the canary token never appears in a log line`
- `the canary token is sent only to a credential host`
- `an outbound request to an unlisted host fails the allowlist check`
- `an authorization header to a non credential host fails the allowlist check`
- `the allowlist check fails when a new fetch host is introduced into the source`
- `the lockfile contains no analytics or telemetry package`
- `every relative link in the security policy and threat model resolves`
- `the private reporting endpoint named in the policy responds`

### Performance Budget

n/a

### Out of Scope

- Do not add an outbound proxy, an egress firewall, or a network policy; the threat model records why
- Do not change how credentials are encrypted or stored; `#61` owns that and the threat model describes it
- Do not add a secret scanner beyond the checks named here; Gate 5 already runs CodeQL
- Do not modify `scripts/ci/check-forbidden-patterns.mjs`; add the new checks as separate scripts
- Do not write a compliance document, a SOC 2 mapping, or a data processing agreement

### Dependencies

Blocked by #61, which defines how bring-your-own-key credentials are stored and therefore what the threat
model must describe, and by the link checker created in
`docs/issues/epic-12-launch/030-self-host-guide.md`.

### Verification

```bash
node scripts/ci/check-egress-allowlist.mjs
node scripts/ci/check-no-telemetry.mjs
node scripts/ci/check-doc-links.mjs SECURITY.md docs/THREAT_MODEL.md
pnpm --filter @infracanvas/api test:integration
pnpm lint
```

### Risk Tier

tier:3 - docs or tests only

### Size

size:m - 200 to 600 lines
