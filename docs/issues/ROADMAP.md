# Redesign roadmap

The order in which the specs in this directory are meant to be executed, and why that order and not
another. `README.md` covers the file format and the seeding commands; this covers sequencing.

## How to use this as a work queue

An agent picks the lowest-numbered issue in the earliest phase whose `Dependencies` are all closed,
reads **only** that file and the spec it links, and delivers a pull request that closes it. Nothing
here requires reading another issue to understand this one — where an issue genuinely needs a
contract another issue defines, it names it under `Dependencies` and does not start until that one
has landed.

Two rules make the queue safe to run unattended:

- **A phase does not begin until the previous phase's issues are closed.** Phases are not
  suggestions; each one removes a class of blocker the next one would otherwise trip over.
- **Within a phase, the numeric prefix is order, not priority.** Two issues in one phase with no
  dependency between them may be taken in either order or in parallel.

## Why the phases are in this order

The redesign is sequenced around three facts about the current repository.

**A large amount of finished product is unlanded.** PR #174 is a 46-commit integration branch
containing seven other open PRs — the copilot, the simulation dashboard, experiments, the IR patch
protocol, the analysis queue. Phase 0 lands that content before anything is built on top of it,
because building against `main` means building against a snapshot that is months behind the work.

**Several gates do not enforce what they claim.** The 85% diff-coverage gate has never measured
anything, the bundle budget cannot see a `.wasm` file, and the tier-1 security review exists only as
a label. Every later phase is verified by those gates, so they are repaired in Phase 0 while the
repairs are cheap and the blast radius is small.

**Tenancy is the widest change in the plan.** Every table, every query and every downstream issue
Contract references `workspace_id`. It lands in Phase 1 because a spec written before it exists has
to be rewritten after, and a spec written after it exists is written once.

## The phases

| Phase | Theme                                                  | Epics touched   | Gate risk                                    |
| ----- | ------------------------------------------------------ | --------------- | -------------------------------------------- |
| **0** | Land what exists; make the gates honest                | 0, 2, 11        | Coverage gate turning on is the one to watch |
| **1** | Tenancy, and connecting the engine that already exists | 15, 16, 1, 2, 7 | Migration reversibility (Gate 4)             |
| **2** | The Rust simulation core                               | 17, 7           | Bundle budget (Gate 6)                       |
| **3** | Deep repository understanding                          | 1, 3, 4, 5      | Ingest performance budget (Gate 6)           |
| **4** | Workload facts, elicitation, the option space          | 6, 7            | none — deterministic and offline-testable    |
| **5** | The 23 missing resource contracts                      | 2, 8            | Schema version bumps (Gate 4)                |
| **6** | Governance: audit, approvals, policy, budgets          | 16              | Destructive DDL approval                     |
| **7** | Deploy, test, measure                                  | 8, 9, 10, 12    | Tier 1 throughout; spends real money         |
| **8** | Surface: canvas, MCP, launch                           | 11, 14, 12      | Bundle budget                                |

## Phase 0 — Land what exists; make the gates honest

Two independent tracks that can run in parallel.

**Track A, the verified defects.** Four small fixes, each shipping the test that would have caught
it. `010` must land before any resource contract is written, because 23 cost models are about to be
written against a lookup that currently answers the wrong question.

**Track B, the gates.** The coverage sequence (`050`–`070`) is three issues rather than one on
purpose: `Diff coverage` is one of the 25 required checks and has never enforced anything, so
switching it on in a single step reds every open pull request at once. Add the reporters, then
measure and report, then ratchet.

**Track C, splitting PR #174.** Each split is a separate issue so each gets its own review. The
splits depend on nothing in Tracks A and B and can proceed alongside them.

## Phase 1 — Tenancy, and connecting the engine

`organizations` and `workspaces` land first, then RLS, then the repointing of every existing query.
`user_id` is renamed rather than dropped, so the migration is reversible and the provenance survives.

In parallel, the prediction engine gets connected to the product for the first time: path extraction
from the IR, the real p95 replacing the literal zero that suppresses every latency objective, and the
36,023-rate price snapshot replacing the hand-shaped file that prices three of four regions at zero.

## Phase 2 — The Rust simulation core

Ported behind a conformance harness that runs one fixture corpus under four runners. The port order
is set by product risk: the models with no product caller go first, so a mistake in the hardest
mathematics cannot reach a user.

## Phases 3 to 8, and how they satisfy the contract rule

`README.md` requires that an issue's contracts exist before it is startable: _"If you cannot write
it, the issue is not ready and something it depends on has to land first."_ Every phase here is
specified up front, which appears to break that rule and does not, because of how the contracts are
authored.

A later issue does not **guess** at an interface an earlier one will produce. It **defines** that
interface, and the earlier issue's Contract section carries the same definition. The job queue's row
shape is written once and appears identically in the issue that creates the table and in the issues
that enqueue work; the Rust simulation API is written once and appears identically in the issue that
builds it and in the issues that call it. Where two issues share a type, they share the text.

That inverts the usual risk. The danger the rule guards against is two agents inventing two different
interfaces for the same seam. Authoring both sides together removes that danger more thoroughly than
sequencing does, because sequencing only guarantees the second agent sees the first agent's choice —
it does not guarantee the choice was the right one for the caller.

What this does cost: an issue whose dependency has not landed is **not yet startable**, and its
`Dependencies` section says so. The queue rule at the top of this document is what enforces it. A
spec being written is not the same as a spec being ready, and `pnpm gh:issues` will label all of them
`agent-ready` — so the phase ordering here, not the label, is what decides what may be picked up.

## Epic tracking issues

| Epic               | Label                | Tracking issue  |
| ------------------ | -------------------- | --------------- |
| 0 Delivery         | `epic:0-delivery`    | #1              |
| 1 Data             | `epic:1-data`        | #2              |
| 2 IR               | `epic:2-ir`          | #3              |
| 3 Engine           | `epic:3-engine`      | #4              |
| 4 Retrieval        | `epic:4-retrieval`   | #5              |
| 5 Graph RAG        | `epic:5-graphrag`    | #6              |
| 6 Brain            | `epic:6-brain`       | #7              |
| 7 Prediction       | `epic:7-prediction`  | #8              |
| 8 Codegen          | `epic:8-codegen`     | #9              |
| 9 Deploy           | `epic:9-deploy`      | #10             |
| 10 Load test       | `epic:10-loadtest`   | #11             |
| 11 Web             | `epic:11-ui`         | #12             |
| 12 Launch          | `epic:12-launch`     | #13             |
| 13 Copilot         | `epic:13-agent`      | #117            |
| 14 MCP             | `epic:14-mcp`        | #118            |
| 15 Tenancy         | `epic:15-tenancy`    | not yet created |
| 16 Governance      | `epic:16-governance` | not yet created |
| 17 Simulation core | `epic:17-simcore`    | not yet created |

Epics 15 to 17 need tracking issues and labels before their specs can be seeded. `.github/labels.yml`
stops at `epic:12-launch`, and `seed-epics.mjs` and `seed-milestones.mjs` stop at 12; extending all
three is `epic-0-delivery/160-extend-epic-seeding-to-seventeen.md`, which is therefore a dependency
of every Phase 1 issue.
