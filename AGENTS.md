# AGENTS.md

Instructions for coding agents working in this repository. This is the canonical agent instruction
file: `CLAUDE.md` is a symlink to it, Codex CLI and Cursor read it natively, and `.cursor/rules/*.mdc`
carries only the glob-scoped rules this flat format cannot express.

`README.md` explains the project to humans. This file explains how to work in it.

## Project overview

InfraCanvas turns a source repository into a proposed AWS architecture, predicts its cost, latency,
throughput and availability, generates Pulumi code for it, and can deploy and load-test it in the
user's own account.

A pnpm + turbo monorepo:

| Path                 | What it is                                              |
| -------------------- | ------------------------------------------------------- |
| `apps/web`           | React canvas and dashboards                             |
| `apps/api`           | Express BFF, Postgres-backed                            |
| `packages/core`      | Canvas/IR conversion, pricing, prediction               |
| `packages/ir-schema` | Versioned JSON Schema, the authority for both languages |
| `crates/ic-engine`   | Rust ingestion engine (parse, chunk, embed, index)      |
| `services/brain`     | Python agent runtime and retrieval                      |
| `db/migrations`      | dbmate migrations, the schema source of truth           |
| `docs/issues`        | The backlog, as reviewable files                        |
| `scripts/ci`         | The enforcement scripts the gates run                   |

Two rules underpin the whole design, and both are load-bearing when you write code here:

1. **An issue is startable only when its contracts already exist.** No issue says "design the X
   interface". The interface is written into the issue, or the issue is blocked on the work defining
   it.
2. **Deterministic where truth exists, models only for judgement.** Cost comes from the AWS Price
   List. Well-Architected checks are coded rules plus Checkov. Pulumi output is templated per
   resource. A model proposes designs and explains trade-offs; it never freehands infrastructure.

## The loop

This repository is built by agents working a queue. One pass of the loop:

1. **Pick** the lowest-numbered issue in the earliest phase of `docs/issues/ROADMAP.md` whose
   `Dependencies` are all closed, and which is labelled `agent-ready`. Do not pick an issue in a
   phase whose predecessor phase is still open.
2. **Claim** it, so the other agents do not take the same one:
   ```bash
   gh issue edit <N> --add-label status:in-progress --add-assignee johnbekele
   ```
3. **Isolate** — work in your own worktree and branch, never directly on `main`:
   ```bash
   scripts/agent/new-worktree.sh <slug> <base-branch-name>
   ```
4. **Read** only that issue and the spec it links. The issue text is the contract. If you find
   yourself inventing an interface, stop: the issue is not ready, and inventing one guarantees the
   next agent invents a different one.
5. **Implement** to the Contract exactly, and respect **Out of Scope**. Adjacent code that looks
   tempting to clean up is how a 200-line change becomes an unreviewable one.
6. **Verify** locally before pushing. `pnpm verify` runs what CI will run:
   ```bash
   pnpm verify              # format, lint, typecheck, forbidden patterns, unit tests
   pnpm verify --fast       # format, lint, typecheck only
   pnpm verify --integration # adds the Postgres-backed suites
   ```
7. **Open a pull request** that closes the issue, ticks the whole checklist, and pastes **real
   command output** as verification. "Tests pass" is not evidence.
8. The gates decide. Fix what they find; never bypass them.

`docs/ORCHESTRATION.md` covers running several agents at once: lane ownership, worktree conventions,
and what to do when two lanes collide.

## Commands

```bash
pnpm install          # also installs the Gate 1 git hooks via lefthook
pnpm verify           # the local mirror of the CI gates - run before every push
pnpm lint             # ESLint across the workspace
pnpm format           # Prettier write
pnpm typecheck        # tsc across the workspace
pnpm test             # unit tests
pnpm test:integration # needs DATABASE_URL and a running Postgres
pnpm db:up            # start Postgres in Docker
pnpm db:migrate       # apply migrations with dbmate
```

Install `gitleaks` (`brew install gitleaks`) so the pre-commit hook can scan staged changes for
credentials. Without it the hook warns and continues, and CI catches it later than you want.

## Quality gates

Ten gates, described in full in `docs/DELIVERY.md`. What matters while you work:

| Gate | Blocks on                                                                 |
| ---- | ------------------------------------------------------------------------- |
| 0    | An issue missing a contract, acceptance criteria, tests, or verification  |
| 1    | Local commit: formatting, lint, staged secrets, commit message grammar    |
| 2    | Format, ESLint, Ruff, Clippy, `tsc`, `mypy --strict`, forbidden patterns  |
| 3    | Unit, integration, and 85% coverage of changed lines                      |
| 4    | Generated-type drift, irreversible migrations, unapproved destructive DDL |
| 5    | Secrets, vulnerable dependencies, disallowed licences, IaC policy         |
| 6    | Benchmark regression, memory ceiling, bundle budget                       |
| 7    | PR hygiene, risk-tier routing, security review on tier 1                  |
| 8    | Merge queue re-runs every required check against the merged result        |
| 9    | Nightly end-to-end, retrieval quality, cost-model accuracy                |

Rules about the gates themselves:

- **Never bypass a gate.** No `--no-verify`, no admin merge. If a gate is wrong, change the gate in
  its own pull request so the change is reviewable.
- **Every gate job always runs and decides internally whether it has work to do.** A job skipped by
  a job-level `if` reports a `skipped` conclusion, and a skipped job that a ruleset requires can
  leave a pull request permanently unmergeable.
- **A guard must name the artefact the job actually consumes**, not a neighbouring directory. A gate
  that fails for an unrelated reason is worse than one switched off, because it teaches everyone to
  read red as noise.

### Risk tiers

Derived from the **paths a pull request touches**, not from what the author claims:

- **Tier 1** — auth, IAM, deployment, credentials, code generation, or the gates themselves. Needs a
  passing security review in addition to every other gate.
- **Tier 2** — normal application code.
- **Tier 3** — docs or tests only.

## Git and GitHub

**Never use an assistant profile for any git or GitHub operation.**

- Use the **`gh` CLI** for all remote operations (issues, pull requests, labels, branches, rulesets).
  It is authenticated as **johnbekele**, the only profile permitted here.
- No GitHub MCP server is configured on this machine. Do not wait for `mcp__github__*` tools; they do
  not exist here. `gh` is the supported path.
- `gh` reads its token from the OS keyring, which sandboxed processes cannot reach. Run `gh`
  **outside the sandbox**, or authentication fails with a misleading "token in keyring is invalid".
  Verify with `gh api user --jq .login`.
- Use terminal git for local operations only: staging, committing, local branches.
- **Never add an AI or assistant co-author trailer.** Gate 2 rejects commits carrying
  `Co-Authored-By: Claude`, `Generated with`, or similar.
- Do not commit unless you were asked to.

### Commit identity

This is a personal project. Every commit must be authored by the personal account **johnbekele**:

```
user.name  = John Bekele
user.email = 164889902+johnbekele@users.noreply.github.com
```

These are set in this repository's local git config, which every worktree shares. **Do not remove or
"correct" them**, and never let a commit fall through to the global config: that carries the Thomson
Reuters work address `yohans.bekele@thomsonreuters.com`, which GitHub resolves to the work account
`johnbekele6130593`, so the commit attributes personal work to an employer.

Check before your first commit in a session, and after any clone:

```bash
git config --get user.email   # must be the noreply address above
```

If commits were already made with the wrong address and are not yet merged, rewrite them before the
pull request is reviewed:

```bash
git rebase --exec 'git commit --amend --no-edit --reset-author' origin/main
git log origin/main..HEAD --format='%an <%ae>'   # verify
```

## Writing issue specs

The backlog lives in `docs/issues/<epic>/NNN-slug.md` and is pushed to GitHub with `pnpm gh:issues`
(idempotent, matched by title). `docs/issues/README.md` has the format. The sections usually done
badly:

- **Contract** — copy-pasteable signatures, DDL, or types. If you cannot write it, the issue is not
  ready and something it depends on has to land first.
- **Acceptance Criteria** — observable behaviours, one per line. "Handles errors correctly" is not
  checkable; "returns null rather than throwing when the ciphertext cannot be decrypted" is.
- **Required Tests** — named cases including failure and edge cases. An agent writes exactly the
  tests listed, so an omission here becomes a coverage gap nobody notices.
- **Out of Scope** — the main defence against drift. Name the adjacent code that will look tempting.

## Code standards

### Modularity

- One responsibility per file. Do not pack multiple components into one file.
- Extract reusable logic into modules; organise files in precisely named folders.
- Remove unused code and dependencies rather than leaving them for later.

### TypeScript

- Avoid `any`. Use real types and interfaces; prefer strict typing.
- Public API changes are reflected in `docs/`.

### Comments

Write a comment to explain a constraint, a trade-off, or a non-obvious reason. Do not narrate what
the code does, and never explain the change you are making — that belongs in the pull request, not in
the source.

### Architecture principles

- **Reliable** — robust error handling, graceful degradation.
- **Low latency** — the budgets in `docs/DELIVERY.md` are product requirements, enforced by Gate 6.
- **Easy to use** — clear APIs.
- **Secure** — follow OWASP, validate inputs, sanitise outputs.
- **Horizontally scalable** — stateless design, no hidden bottlenecks.

### Testing

- Write tests alongside the code, not afterwards.
- Cover the edge and failure cases, not just the happy path.
- Use descriptive names that state the expected behaviour.

## Security

- **Never commit a secret.** No API keys, tokens, passwords or credentials, including in test
  fixtures. Scan before pushing; `pnpm verify` and the pre-commit hook both check.
- Long-lived cloud keys are forbidden by the deployment model. AWS access is via a cross-account role
  with an external ID.
- Treat anything under `db/migrations` as tier-1-adjacent: migrations must be reversible, and
  destructive DDL needs the `db:destructive-approved` label to pass Gate 4.

## Working style

- **Ask for review after each phase** rather than delivering one monolithic change.
- **Stop and discuss architectural decisions** before implementing them.
- Prefer open source and free solutions. Document trade-offs when several options exist.
