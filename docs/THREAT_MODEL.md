# Threat model

InfraCanvas holds credentials that open a cloud account and a source repository. This document names
what is protected, where it lives, which boundaries an attacker crosses, and what this project
deliberately does not defend against.

The no-egress promise is three checkable claims, not one unfalsifiable sentence: outbound hosts are
allowlisted in source (`scripts/ci/check-egress-allowlist.mjs`), credentials never appear in a
response or log line (canary integration test), and the lockfile carries no analytics package
(`scripts/ci/check-no-telemetry.mjs`). Reporting and response windows live in [`SECURITY.md`](../SECURITY.md).

## Assets

| Asset                         | Store                                                                | Encryption at rest                            | Process that reads it                                       |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| GitHub access token           | Postgres `github_tokens.access_token_encrypted`                      | AES-256-GCM via `ENCRYPTION_KEY`              | API (`apps/api`), when calling GitHub                       |
| AWS connection external ID    | Postgres `aws_connections.external_id_encrypted` (see deploy epic)   | AES-256-GCM via `ENCRYPTION_KEY`              | API, only when calling `sts:AssumeRole`                     |
| Temporary AWS session creds   | Process memory only; never persisted                                 | n/a                                           | API / CodeBuild deploy path, for one assume-role session    |
| Model API keys (BYOK)         | Postgres `llm_credentials.api_key_encrypted`                         | AES-256-GCM via `ENCRYPTION_KEY`              | API (verify and future brain calls); brain decrypts locally |
| Repository contents           | Postgres analysis tables; engine working copy during ingest          | Disk / DB as the operator configures Postgres | API, Rust engine, Python brain                              |
| Embeddings                    | Postgres `chunk_embeddings`                                          | Disk / DB as the operator configures Postgres | Rust engine (write), Python brain (read)                    |
| Generated infrastructure code | User's target repository (via GitHub) and local generation artefacts | n/a (source text)                             | Codegen in `packages/core`; push path in the API            |

Long-lived AWS access keys are not an asset this system stores. Account connection uses a
cross-account role and a per-connection external ID
([`docs/issues/epic-9-deploy/010-cross-account-role-connect.md`](issues/epic-9-deploy/010-cross-account-role-connect.md));
temporary credentials from `AssumeRole` are not written to the database.

## Configured outbound hosts

Literal GitHub hosts are listed in `ALLOWED_HOSTS` / `CREDENTIAL_HOSTS` in
`scripts/ci/check-egress-allowlist.mjs`. Hosts reached through the AWS SDK or a configured model
provider are resolved from client configuration rather than from free-form literals, and are part of
the same policy:

| Host / endpoint family              | How it is selected                                              |
| ----------------------------------- | --------------------------------------------------------------- |
| `api.github.com`, `github.com`      | Fixed literals in the API                                       |
| `api.openai.com`                    | Default for OpenAI; override with `llm_credentials.base_url`    |
| `api.anthropic.com`                 | Default for Anthropic; override with `llm_credentials.base_url` |
| `generativelanguage.googleapis.com` | Default for Google Generative Language                          |
| AWS service endpoints               | SDK resolution from `AWS_REGION` / `AWS_ENDPOINT_URL_*`         |
| Local Ollama (`localhost`)          | Default `http://localhost:11434`; override with `base_url`      |

## Trust boundaries

### Browser to API

- **Attacker gains:** session cookie, ability to act as the signed-in user, any data the API returns
  for that user.
- **Mitigation:** HttpOnly session cookie, short-lived JWT backed by a revocable `sessions` row,
  CORS allowlist, rate limits on credential-presenting routes, request body size limit. Stored
  secrets are never included in JSON responses (keys return only a four-character hint).

### API to Postgres

- **Attacker gains:** every encrypted credential and all repository-derived data if they can read or
  write the database.
- **Mitigation:** application-layer AES-256-GCM for tokens and API keys; parameterised queries;
  sessions scoped by user id. The operator is responsible for network exposure of Postgres (see
  non-goals).

### API to GitHub

- **Attacker gains:** the user's GitHub token in transit, or the ability to call GitHub as that user
  if the token is stolen from storage.
- **Mitigation:** tokens sent only to `api.github.com` with `Authorization`, enforced by the egress
  allowlist and `CREDENTIAL_HOSTS`; canary test fails if the token appears in a response or log.

### API to AWS

- **Attacker gains:** temporary session credentials for the connected account, or the ability to
  assume the user's role if the external ID leaks.
- **Mitigation / gap:** design is cross-account role + external ID with no persisted access keys
  ([`docs/issues/epic-9-deploy/010-cross-account-role-connect.md`](issues/epic-9-deploy/010-cross-account-role-connect.md)).
  Until that lands, no AWS customer credentials are stored. SDK hosts come from `AWS_REGION` /
  `AWS_ENDPOINT_URL_*`, not from ad-hoc literals.

### API to model provider

- **Attacker gains:** the user's model API key, or billed usage on that key.
- **Mitigation:** BYOK keys encrypted at rest
  ([`docs/issues/epic-6-brain/010-byok-llm-credentials.md`](issues/epic-6-brain/010-byok-llm-credentials.md));
  verify failures never echo the key; outbound defaults are policy-listed; custom `base_url` is the
  operator's choice of endpoint.

### Generated pull request to the target repository CI

- **Attacker gains:** execution of attacker-controlled workflow code in the user's repository CI if
  generation were compromised or a malicious template shipped.
- **Mitigation / gap:** generated IaC is validated and scanned (Checkov in Gate 5; codegen validation
  in the codegen epic). Workflow generation must stay reviewable in the opened pull request; further
  hardening of generated workflows is tracked with the launch and codegen issues under
  [`docs/issues/epic-8-codegen/`](issues/epic-8-codegen/) and
  [`docs/issues/epic-12-launch/`](issues/epic-12-launch/).

### Load-test runner task to the deployed target

- **Attacker gains:** ability to send synthetic traffic at the user's deployed experiment, or to
  reach elsewhere if the runner's egress were unrestricted.
- **Mitigation / gap:** runner and script generation are specified in
  [`docs/issues/epic-10-loadtest/010-k6-script-generation.md`](issues/epic-10-loadtest/010-k6-script-generation.md);
  scripts are derived from the IR so paths cannot invent targets. Network policy for the runner task
  is out of scope for the source-level egress check (see below).

## Explicit non-goals

This model does **not** defend against:

- A Postgres instance the operator exposes to the internet or leaves without authentication
- A malicious or compromised dependency already in the install tree
- A GitHub token (or model key) that was already compromised outside this system
- A self-hoster who runs the API or the browser on a host they do not control
- Runtime egress that never appears as a host string in this repository

## Egress check limitation

The egress allowlist is a **source-level check**, not a runtime sandbox. It fails CI when a new
outbound host appears in the application source, or when an `Authorization` header would target a
host outside `CREDENTIAL_HOSTS`. It does not install a proxy, firewall, or network policy. A
self-hoster who starts services with `pnpm dev` has no egress proxy; the check exists so every
deployment, including unconfigured ones, still fails the build when the promise stops being true in
source. A stronger network control would only protect environments that run it, and is deliberately
out of scope here.
