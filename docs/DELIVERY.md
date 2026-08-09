# Delivery System

InfraCanvas is built largely by coding agents working from GitHub issues. That only produces good
software if the issues are precise and the gates are honest. This document describes both.

Two rules underpin everything:

1. **An issue is startable only when its contracts already exist.** No issue says "design the X
   interface". The interface is written into the issue, or the issue is blocked on the work that
   defines it.
2. **Deterministic where truth exists, models only for judgement.** Cost comes from the AWS Price
   List. Well-Architected checks are coded rules plus Checkov. Pulumi output is templated per
   resource. A model proposes designs and explains trade-offs; it never freehands infrastructure.

## The ten gates

| Gate | Name                   | Runs            | Blocks on                                                                 |
| ---- | ---------------------- | --------------- | ------------------------------------------------------------------------- |
| 0    | Issue readiness        | Issue edit      | Missing contract, acceptance criteria, tests, or verification commands    |
| 1    | Pre-commit             | Local commit    | Formatting, lint, staged secrets, commit message grammar                  |
| 2    | Static                 | PR, merge queue | Format, ESLint, Ruff, Clippy, `tsc`, `mypy --strict`, forbidden patterns  |
| 3    | Test                   | PR, merge queue | Unit, integration, and 85% coverage of changed lines                      |
| 4    | Contract and migration | PR, merge queue | Generated-type drift, irreversible migrations, unapproved destructive DDL |
| 5    | Security               | PR, merge queue | Secrets, vulnerable dependencies, disallowed licences, IaC policy         |
| 6    | Performance            | PR, merge queue | Benchmark regression, memory ceiling, bundle budget                       |
| 7    | Review                 | PR              | PR hygiene, risk-tier routing, security review on tier 1                  |
| 8    | Merge queue            | Merge           | Re-runs every required check against the merged result                    |
| 9    | Nightly                | Schedule        | End-to-end pipeline, retrieval quality, cost-model accuracy               |

Every gate job **always runs and decides internally whether it has work to do**. A job skipped by a
job-level `if` reports a `skipped` conclusion, and a skipped job that a ruleset requires can leave a
pull request permanently unmergeable. Gates for components that do not exist yet log a notice and
pass, then begin enforcing automatically once the component lands.

A guard must name **the artefact the job actually consumes**, not a neighbouring directory that
happens to appear around the same time. Guarding the OpenAPI drift check on `services/brain`
existing, rather than on the generator script existing, turned a green gate red the moment an empty
Python skeleton landed - for a reason that had nothing to do with the change under review. A gate
that fails for an unrelated reason is worse than one that is switched off, because it teaches
everyone to read a red check as noise, and that is how a real failure gets waved through.

## Writing an issue an agent can execute

Use the Agent Task template. Gate 0 rejects anything incomplete. The bar is that an agent with no
prior context reads only the issue and its linked spec, and produces code that passes every gate on
the first attempt.

The two sections that decide success:

- **Contract** — exact signatures, types, DDL, or schema. Copy-pasteable and non-negotiable. If you
  cannot write it, the issue is not ready.
- **Out of Scope** — what must not be touched. This is the main defence against an agent
  "helpfully" refactoring adjacent code and turning a 200-line change into an unreviewable one.

Also required: at least two checkbox acceptance criteria, at least two named tests including a
failure or edge case, explicit `CREATE`/`MODIFY`/`DELETE` file paths, a performance budget or
`n/a`, dependencies, and runnable verification commands.

## Risk tiers

Tier is derived from the **paths a pull request touches**, not from what the author claims, so
nobody can quietly downgrade their own change.

- **Tier 1** — auth, IAM, deployment, credentials, code generation, or the gates themselves.
  Requires a passing security review job in addition to every other gate.
- **Tier 2** — normal application code.
- **Tier 3** — docs or tests only. Eligible for the fast lane.

### Why approval is not currently required

The ruleset asked for one approving review including a code owner. With a single maintainer that is
not a high bar, it is an unreachable one: `CODEOWNERS` names the same person who opens every pull
request, and GitHub does not permit self-approval. Every pull request in the repository was therefore
permanently unmergeable, and the only way through was the admin bypass that `CLAUDE.md` forbids.

A rule that can only be satisfied by breaking another rule is not a quality bar. It is a habit of
overriding protections, which costs more than the review was ever worth.

So approval is not required today, and all 25 status checks still are. Nothing merges without the
gates passing; the change is that no human signature is demanded from someone who cannot give it.
Restore `required_approving_review_count` to 1 and `require_code_owner_review` to true the moment a
second maintainer exists or agent pull requests are opened by a separate account, which is the point
at which the requirement starts meaning something.

## Waves

Issues are specified in waves, because Gate 0 forbids specifying work whose contracts do not exist:

- **Wave 1** — Epics 0, 1, 2. Delivery infrastructure, the Postgres foundation, and the
  Architecture IR that everything downstream reads.
- **Wave 2** — Epics 3 to 6. Ingestion, retrieval, graph RAG, and the agent runtime.
- **Wave 3** — Epics 7 to 12. Prediction, code generation, deployment, load testing, UI, launch.

## Performance budgets

These are product requirements, enforced by Gate 6 rather than aspirations in a document.

| Area              | Budget                                                 |
| ----------------- | ------------------------------------------------------ |
| Ingest            | 100k-file repository under 120s, peak RSS under 300 MB |
| Incremental index | 100 changed files under 5s                             |
| Retrieval         | p95 under 250 ms at 1M chunks                          |
| Brain             | Steady-state RSS under 512 MB                          |
| API               | p99 under 100 ms on non-AI routes                      |
| Web               | 500-node canvas at 60fps, initial JS under 250 KB gzip |

The web budget is currently ratcheted at 260 KB because the app ships 255 KB in a single chunk.
The ratchet blocks further growth; reducing it to the 250 KB target is tracked separately.

## Local setup

```bash
pnpm install          # also installs the Gate 1 git hooks via lefthook
pnpm lint             # ESLint across the workspace
pnpm format           # Prettier
pnpm turbo typecheck  # TypeScript
```

Install `gitleaks` (`brew install gitleaks`) so the pre-commit hook can scan staged changes for
credentials. Without it the hook prints a warning and continues; CI still scans.

## Repository administration

Branch protection, labels, and milestones are version-controlled and applied by script, so the rules
of the project are reviewable in a pull request instead of being clicked into a settings page.

```bash
pnpm gh:labels       # sync .github/labels.yml
pnpm gh:milestones   # create the epic milestones
pnpm gh:ruleset      # apply .github/rulesets/main.json
```

All three are idempotent and accept `--dry-run`. They need `gh` authenticated as `johnbekele` and
must run outside a sandbox so `gh` can reach the OS keyring.

A required status check only becomes enforceable after a workflow has reported it at least once, so
apply the ruleset after the first pull request has run the gates.
