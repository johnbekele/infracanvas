# Running several agents at once

`AGENTS.md` describes the loop one agent runs by hand. This describes running three of them — Claude
Code, Codex and Cursor — against the same repository unattended, with a supervisor that picks work,
dispatches an agent at it, verifies the result, and merges what passes.

The queue, the contracts and the pass/fail verdict are already machine-readable: `docs/issues/` holds
the specs, the ten gates hold the verdict. The orchestrator adds the part that was still manual —
choosing what is safe to start, giving each agent an isolated tree, and deciding when a green pull
request may merge — and it does all of that in `packages/agent-loop`.

## The one rule that makes it safe

**Agents never run git, `gh`, or a merge. They only edit files inside their own worktree.** Every
irreversible action — the claim, the commit, the push, the pull request, the merge — is taken by
deterministic orchestrator code in [`packages/agent-loop`](../packages/agent-loop). A model that goes
wrong can waste a worktree; it cannot merge itself, push to `main`, or corrupt the queue's bookkeeping.

The prompt each agent receives says this in as many words, and the loop enforces it structurally: the
agent's working directory is a linked worktree, and nothing in the loop hands it a GitHub token.

## Starting it

```bash
pnpm loop                # run continuously until the queue empties or the kill switch appears
pnpm loop --once         # a single scheduling pass, then exit
pnpm loop --lane B       # restrict to one lane, for a controlled run
pnpm loop --no-merge     # get pull requests green and mergeable, but stop short of merging
pnpm loop --status       # print the current run snapshots
pnpm loop --explain 202  # say whether an issue is eligible, and if not, why
```

The loop must run **outside any sandbox**: `gh` reads its token from the OS keyring, which a sandboxed
process cannot reach (see `AGENTS.md`).

## Lanes: ownership by path, not by feature

The rule that makes parallelism safe: **if two tasks touch the same file, they are not independent and
must be serialised.** Git gives no warning — two worktrees editing one file on two branches is silent
until merge.

A lane is a tool, and which tool takes an issue is decided by its `area:` labels:

| Lane | Tool            | Areas it takes                                    | Owns                                                        |
| ---- | --------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| A    | **Claude Code** | `area:db`, `area:ir`                              | `db/`, `apps/api/src/lib/db/`, `packages/ir-schema/`        |
| B    | **Codex**       | `area:ci`, `area:infra`                           | `.github/`, `scripts/ci/`, `scripts/gh/`                    |
| C    | **Cursor**      | `area:web`, `area:api`, `area:rust`, `area:brain` | `apps/web/`, `packages/core/`, `crates/`, `services/brain/` |

An issue that spans lanes (for example `area:api,area:db`) is taken by the higher-precedence lane —
B, then A, then C — so the tool that owns the more sensitive surface leads and the others stay clear.

Whether it is _safe_ to start is a separate question from which lane owns it, and the loop computes it
rather than reading it from a table. A hand-maintained assignment goes stale the moment the backlog
moves: earlier in this project one dispatched an agent onto three issues an open pull request had
already implemented, a guaranteed conflict. The scheduler instead parses each spec's `### Files`
section — which Gate 0 forces every issue to fill in — and refuses to start an issue whose declared
paths overlap one already running.

## What the loop will start

An issue is eligible only when every one of these holds. They are checked cheapest-first, and the
first failure is what `--explain` reports:

1. labelled `agent-ready`, and not `status:in-progress` or `status:blocked`;
2. an `area:` label maps it to a lane;
3. every `#N` in its `### Dependencies` section is **closed**;
4. no lane already holds a local claim on it;
5. **no open pull request already says `Closes #N`** for it;
6. its declared paths do not overlap any running issue's.

Rule 5 is the collision guard. Rule 3 means `agent-ready` is necessary but not sufficient: it says the
spec is complete, not that the work is unblocked.

## The per-issue state machine

```
claim -> worktree -> implement -> verify -> deliver -> watch CI -> merge -> cleanup
                          ^          |                     |
                          +--repair--+ (<=3)               +--repair--+ (<=2)
```

For each issue the loop claims it (label plus a local lockfile), creates a worktree, and prompts the
lane's agent with the issue body verbatim. It then runs `pnpm verify` **itself** — the agent's word
that it is done does not count — and feeds any failure back for another pass, up to the local repair
budget. Once green, it ticks the pull request checklist from facts it can prove (the changed paths
against the declared paths, a secret scan of the diff, the commit log for assistant trailers), commits
under the personal identity, pushes, and opens a pull request whose body is built to satisfy Gate 7 on
the first try. It watches CI, repairs within budget, and merges only when the predicate in
[`merge.ts`](../packages/agent-loop/src/merge.ts) is satisfied.

An issue that exhausts a budget, produces no changes, reports itself blocked, or trips the identity or
secret guard is commented on, labelled `status:blocked`, released, and left for a human. The claim and
the worktree are cleaned up on every exit path.

## Merge policy

The loop is configured to **merge every tier, including tier 1, unattended**, because the repository
ruleset requires no approving review and the gates are trusted to be the verdict. It merges only when a
fresh read shows the pull request mergeable, every required check green, and no unresolved review
thread — and only pull requests it opened itself, labelled `agent-loop`. The **pre-existing open pull
requests are never touched**; draining those is a separate, human decision. A tier-1 merge is recorded
in the run log with a note that it merged unreviewed, so there is an audit trail.

To take a more conservative stance, run with `--no-merge` (green and mergeable, but the merge click is
left to you) or change `mergeAllTiers` in [`config.ts`](../packages/agent-loop/src/config.ts).

## Budgets and the kill switch

Defaults live in [`config.ts`](../packages/agent-loop/src/config.ts): 45 minutes per agent pass, three
local repair attempts, two CI repair attempts, and three concurrent issues. The point of the budgets
is that a stuck lane holds a claim and starves the queue, so every phase has a deadline after which the
loop moves on.

Create `.agent-loop/stop` to halt the loop between transitions:

```bash
touch .agent-loop/stop     # stop after the current transitions finish
rm .agent-loop/stop        # allow it to resume
```

## Worktrees

One worktree per issue, created by [`scripts/agent/new-worktree.sh`](../scripts/agent/new-worktree.sh),
which the loop wraps rather than reimplements — it already gets the per-tree API port and the
commit-identity guard right. Trees live in a sibling `<repo>-wt/` directory, never under the repository
root, because a nested tree is a second checkout that `git add -A` would commit into the first.

**Cap concurrency at three to five.** The limit is review bandwidth, not CPU: twenty trees is not five
times the throughput of four, it is four times the merge conflicts.

## Two runtime hazards the loop handles

- **The integration suites share one Postgres.** `pnpm verify --integration` is serialised across
  lanes by a file mutex ([`mutex.ts`](../packages/agent-loop/src/mutex.ts)); without it two lanes
  truncate each other's tables and the failure reads as data corruption rather than a scheduling
  mistake. Integration is off unless `DATABASE_URL` is set.
- **`apps/web/vite.config.ts` hardcodes its proxy target to `localhost:3001`.** So a web dev server in
  any tree calls the API on 3001 regardless of which tree started it. The loop never starts a dev
  server — it runs tests, not servers — but if you run one by hand, run only one at a time.

## The run log

Every transition appends JSONL to `.agent-loop/runs/<issue>.jsonl` with a monotonic cursor, alongside
a `<issue>.status.json` snapshot. This is deliberately the same shape as the `agent_runs` /
`agent_run_events` contract in [#198](https://github.com/johnbekele/infracanvas/issues/198), so when
epic 18 lands the reporter ([#201](https://github.com/johnbekele/infracanvas/issues/201)) has a real
producer to forward and the lane board ([#200](https://github.com/johnbekele/infracanvas/issues/200))
has something to draw.

## Before the first unattended run

- Install and authenticate the Cursor CLI, which lane C uses and which is not installed by default:

  ```bash
  curl https://cursor.com/install -fsS | bash
  cursor-agent login
  ```

  Claude Code and Codex are already configured for the LiteLLM proxy.

- Start Postgres and export `DATABASE_URL` if you want the integration suites to run rather than skip:

  ```bash
  pnpm db:up
  ```

- Do a controlled dry run before switching merging on:

  ```bash
  pnpm loop --once --lane B --no-merge
  ```

  Read the resulting pull request end to end, then drop `--no-merge`.

## When a lane blocks

The loop already handles the common cases by commenting and labelling `status:blocked`. When you pick
one up:

- **Missing contract.** The spec is not ready. Fix the file in `docs/issues/`, reseed with
  `pnpm gh:issues`, and let Gate 0 relabel it. Do not invent the interface.
- **A gate looks wrong.** Change the gate in its own pull request. Never `--no-verify`, never an admin
  merge.
- **Phase not finished.** Dependencies enforce this: an issue whose predecessor is open is not
  eligible, so it will not be started early.
