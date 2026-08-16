# Running several agents at once

`AGENTS.md` describes the loop one agent runs. This describes running three of them — Claude Code,
Codex and Cursor — against the same repository without them undoing each other's work.

The queue, the contracts and the pass/fail verdict are already machine-readable: `docs/issues/`
holds the specs, `ROADMAP.md` holds the order, and the ten gates hold the verdict. Orchestration is
therefore not about telling agents what to do. It is about **assigning ownership** so two of them
never edit the same file, and **making the claim visible** so two of them never take the same issue.

## One instruction file

All three tools read the same rules:

| Tool        | Reads                                          |
| ----------- | ---------------------------------------------- |
| Codex CLI   | `AGENTS.md`                                    |
| Cursor      | `AGENTS.md` and `.cursor/rules/*.mdc`          |
| Claude Code | `CLAUDE.md`, which is a symlink to `AGENTS.md` |

So `AGENTS.md` is the single source of truth. Put a rule there unless it can only be expressed as a
glob-scoped Cursor rule, in which case it goes in `.cursor/rules/` and applies to one directory.

Do not let `CLAUDE.md` become a real file again. Two files drift, and the day they disagree is the
day an agent commits with the wrong identity because it happened to read the stale one.

## Lanes: ownership by path, not by feature

The rule that makes parallelism safe: **if two tasks touch the same file, they are not independent
and must be serialized.** Git will not warn you — two worktrees editing one file on two branches is
silent until merge.

So lanes are drawn by path. `docs/issues/ROADMAP.md` already splits Phase 0 into three tracks it
describes as parallel-safe, and they map almost exactly onto the three tools' strengths:

| Lane | Tool            | Track                                 | Owns                                                 |
| ---- | --------------- | ------------------------------------- | ---------------------------------------------------- |
| A    | **Claude Code** | Tenancy and schema — deep, tier 1     | `db/`, `apps/api/src/lib/db/`, `packages/ir-schema/` |
| B    | **Codex**       | The gates — bounded and deterministic | `.github/`, `scripts/ci/`, `scripts/gh/`             |
| C    | **Cursor**      | Verified defects and the web surface  | `apps/web/`, `packages/core/`                        |

Current Phase 0 and Phase 1 assignment:

| Lane | Issues                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | [#190] organizations and workspaces, [#186] token revocation, [#187] no long-lived AWS keys, [#188] cross-origin cookie and CSRF                                                                                  |
| B    | [#177] remove superseded plans, [#178]–[#180] the coverage sequence, [#181] wasm bundle budget, [#182] tier-1 security review, [#183] scheduled gates, [#184] retire the Pages deploy, [#185] extend epic seeding |
| C    | [#189] branch endpoint, [#191] IR validator dispatch, [#192] price lookup ambiguity                                                                                                                               |

Three rules keep the lanes honest:

- **A file has exactly one owner at a time.** If your issue needs a file in someone else's lane,
  stop and say so rather than editing it. The fix is either to sequence the two issues or to move the
  file's ownership for the duration.
- **`AGENTS.md`, `package.json`, `.gitignore` and `pnpm-lock.yaml` are shared.** Everyone touches
  them eventually, so touch them in the smallest possible commit and rebase often.
- **Lane B outranks the others on `.github/` and `scripts/ci/`.** It is rewriting the gates that
  judge everyone else, so its changes land first and the others rebase onto them.

## Claiming an issue

Three agents pulling one queue will grab the same issue unless the claim is visible in the queue
itself. The `status:in-progress` label already exists for this and is currently unused:

```bash
# before starting
gh issue edit <N> --add-label status:in-progress --add-assignee johnbekele

# on finishing, or on abandoning
gh issue edit <N> --remove-label status:in-progress
```

Pick with the claim in mind:

```bash
gh issue list --repo johnbekele/infracanvas \
  --label agent-ready --label 'epic:0-delivery' \
  --search '-label:status:in-progress' --state open
```

An issue is startable only when every issue in its `Dependencies` section is **closed** and its phase
predecessor is complete. The `agent-ready` label means the spec is complete, not that the work is
unblocked — `ROADMAP.md` phase order decides that, as it says itself.

## Worktrees

One worktree per agent per issue. Never two agents in one working directory, and never an agent on
`main`.

```bash
scripts/agent/new-worktree.sh tenancy feat/190-organizations-and-workspaces
```

That script creates `../infracanvas-wt/<slug>` from `origin/main`, verifies the commit identity,
gives the tree its own API port, and installs dependencies.

**Trees live outside the repository root.** A tree nested under the root appears as hundreds of
untracked files including a nested `.git`, and a single `git add -A` commits an entire second
checkout into the first. Claude Code's `--worktree` flag puts trees in `.claude/worktrees/`, which is
gitignored for exactly this reason; the sibling directory is preferred.

**Cap concurrency at three to five.** The limit is review bandwidth, not CPU: an agent's output is
only useful once you have read it. Twenty trees is not five times the throughput of four, it is four
times the merge conflicts.

**Remove a tree once its pull request merges.** Because pull requests here are squash-merged, the
branch never becomes an ancestor of `main`, so `git branch --merged` will not list it and stale trees
accumulate invisibly. Check the pull request state instead:

```bash
gh pr list --head "$(git branch --show-current)" --state all --json number,state
git -C <main-checkout> worktree remove ../infracanvas-wt/<slug>
git -C <main-checkout> worktree prune
```

### Runtime isolation, and one sharp edge

Worktrees isolate files, not runtimes. The bootstrap script gives each tree its own `PORT` for the
API, but `apps/web/vite.config.ts` hardcodes its proxy target:

```ts
proxy: { '/api': { target: 'http://localhost:3001' } }
```

So a web dev server in any tree calls the API on 3001 regardless of which tree started it. Until that
target reads an environment variable, **run only one web dev server at a time.** Two agents each
running `pnpm dev` will silently share one API and one database, and the resulting bug looks like
data corruption rather than a configuration mistake.

## Verifying before pushing

Every lane runs the same command, and it is the same thing CI runs:

```bash
pnpm verify              # format, lint, typecheck, forbidden patterns, unit tests
pnpm verify --fast       # static only, for a tight edit loop
pnpm verify --integration # adds the Postgres-backed suites
```

A local pass is not a guarantee — Gates 4, 5 and 6 (type drift, dependency and licence scanning,
benchmarks and bundle budget) only run in CI. It does mean a green pull request on the first attempt
is the normal case rather than the lucky one.

`git rerere` is enabled in this repository. When three lanes rebase onto a moving `main`, the same
conflict appears repeatedly; rerere records how you resolved it the first time and replays it.

## Merge order

Land in dependency order, smallest first:

1. **Lane B's gate repairs**, because everything else is judged by them. Within lane B the coverage
   sequence [#178] → [#179] → [#180] is strictly ordered: it exists as three issues precisely so that
   switching on a never-enforced required check does not turn every open pull request red at once.
2. **Lane C's defect fixes**, which are small, self-contained, and unblock cost work.
3. **Lane A's tenancy change**, last of the three, because it touches every table and every query and
   rebasing it repeatedly is the expensive option.

Before dispatching two long-running agents, check whether their changes would collide:

```bash
git merge-tree "$(git merge-base main lane-a)" main lane-a
```

## When a lane blocks

- **Missing contract.** The issue is not ready. Fix the spec file in `docs/issues/`, reseed with
  `pnpm gh:issues`, and let Gate 0 relabel it. Do not invent the interface.
- **Needs a file another lane owns.** Say so and stop. Sequence the issues, do not race.
- **A gate looks wrong.** Change the gate in its own pull request. Never `--no-verify`, never an
  admin merge.
- **Phase not finished.** Do not start the next phase early. Each phase removes a class of blocker
  the next would otherwise trip over.

[#177]: https://github.com/johnbekele/infracanvas/issues/177
[#178]: https://github.com/johnbekele/infracanvas/issues/178
[#179]: https://github.com/johnbekele/infracanvas/issues/179
[#180]: https://github.com/johnbekele/infracanvas/issues/180
[#181]: https://github.com/johnbekele/infracanvas/issues/181
[#182]: https://github.com/johnbekele/infracanvas/issues/182
[#183]: https://github.com/johnbekele/infracanvas/issues/183
[#184]: https://github.com/johnbekele/infracanvas/issues/184
[#185]: https://github.com/johnbekele/infracanvas/issues/185
[#186]: https://github.com/johnbekele/infracanvas/issues/186
[#187]: https://github.com/johnbekele/infracanvas/issues/187
[#188]: https://github.com/johnbekele/infracanvas/issues/188
[#189]: https://github.com/johnbekele/infracanvas/issues/189
[#190]: https://github.com/johnbekele/infracanvas/issues/190
[#191]: https://github.com/johnbekele/infracanvas/issues/191
[#192]: https://github.com/johnbekele/infracanvas/issues/192
