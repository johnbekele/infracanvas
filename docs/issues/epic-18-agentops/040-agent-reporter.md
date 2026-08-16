---
title: '[agents] A reporter that makes Claude Code, Codex and Cursor appear on the board'
labels: tier:2, size:m, area:infra, epic:18-agentops
---

### Epic

#197

### Context

`010` to `030` built somewhere for agent activity to be recorded and seen. Nothing writes to it. The
three agents this repository is worked by emit no common event format and cannot be modified, so the
reporter wraps them: it runs the agent as a child process and reports around it.

**Wrapping, not integrating.** Claude Code, Codex and Cursor each have their own output, none of it
structured. A wrapper needs to know only how to start a process, watch it, and notice it exit — which
is identical for all three, and stays identical when a fourth arrives.

**Observability must never break the work.** If the API is down, the wrapped agent still has to run to
completion and still has to exit with its own status. A reporter that fails the run it is watching is
worse than no reporter, because it converts a monitoring outage into lost work. Every reporting call
therefore degrades to a warning, and the child's exit code passes through untouched.

**Heartbeats are the point.** The one thing that cost real time when running these agents was that an
agent which exited without committing looked exactly like one still thinking. `010` distinguishes them
by heartbeat staleness, which only works if something actually heartbeats. That is this script's most
important job, and the reason it must keep beating even while the child is silent.

**This ships the agent's output to a server, so it is treated as such.** The captured stream is the
agent's own stdout, which may contain repository content and, if an agent echoes its environment, a
credential. Lines are truncated, a redaction pass runs over them, and nothing else about the machine
is collected. The destination is the user's own workspace, but that is a reason to be careful rather
than a reason not to be.

### Contract

`scripts/agent/report.mjs`, following the shape of `scripts/local-connector.mjs` — a standalone Node
script, no build step, configured by environment and flags:

```bash
scripts/agent/report.mjs \
  --lane tenancy \
  --agent claude-code \
  --issue 190 \
  -- claude -p --dangerously-skip-permissions < prompt.md
```

Environment:

```
INFRACANVAS_API_URL        default http://127.0.0.1:3001
INFRACANVAS_WORKSPACE_ID   required
INFRACANVAS_AGENT_TOKEN    the token from 020; if absent, the pairing code below is required
INFRACANVAS_PAIRING_CODE   one-time code, exchanged for a token on first run
```

Behaviour:

1. Resolve a credential. A token in the environment is used as-is. Otherwise a pairing code is
   exchanged once via `020`'s endpoint and the result written to `~/.infracanvas/agent-token` with
   mode `0600`, so the code is needed only once and never has to be pasted again.
2. `POST` a run for `--lane`, carrying agent, issue, branch and worktree path. Branch comes from
   `git rev-parse --abbrev-ref HEAD` and the worktree from `git rev-parse --show-toplevel`, both run in
   the current directory.
3. On `409 lane occupied`, exit `75` (`EX_TEMPFAIL`) without starting the child, and name the run
   already holding the lane. Two agents in one lane is the collision the lane model exists to prevent,
   so the reporter refuses rather than reports.
4. Spawn the command after `--`, inheriting stdin, with stdout and stderr teed: through to the
   terminal unchanged, and into the event buffer.
5. Heartbeat every 15 seconds, independent of child output, until the child exits.
6. Flush buffered events at most once a second, batched.
7. On exit, end the run: `succeeded` for code 0, `failed` otherwise, and `failed` on a signal.
8. Exit with the child's own code, or `128 + signal`.

Event mapping:

- One event per output line, `level: 'info'`, or `'error'` for stderr.
- A line of the form `::phase::<name>` sets `phase` on subsequent events and is not itself reported,
  giving an agent a way to label progress without the reporter parsing prose.
- A line of the form `::progress::<0..1>` sets `progress` the same way.
- Lines are truncated to 8192 characters, matching the column's `CHECK`.
- A redaction pass replaces anything matching a token shape — `ica_`-prefixed strings, `ghp_`,
  `github_pat_`, and any `Bearer <token>` — with `[redacted]`.

Buffering:

- A bounded queue of 1000 events. When full, the oldest are dropped and a single
  `warn` event records how many were lost, so a chatty agent costs fidelity rather than memory.
- Failed flushes retry with backoff. After 5 consecutive failures the reporter warns once on the
  terminal and keeps the child running.

### Files

- `scripts/agent/report.mjs` — CREATE: the reporter.
- `scripts/agent/report.test.mjs` — CREATE: the tests below.
- `docs/ORCHESTRATION.md` — MODIFY: how to launch a lane through the reporter.
- `scripts/agent/new-worktree.sh` — MODIFY: print the reporter-wrapped command in its "Next" block.

### Acceptance Criteria

- [ ] Wrapping a command that succeeds ends the run `succeeded` and exits 0.
- [ ] Wrapping a command that fails ends the run `failed` and exits with the child's code.
- [ ] A child killed by a signal ends the run `failed` and the reporter exits `128 + signal`.
- [ ] The child's stdout and stderr still reach the terminal unchanged.
- [ ] Heartbeats continue while the child produces no output.
- [ ] With the API unreachable, the child still runs to completion and the reporter still exits with the
      child's code.
- [ ] A `409` on run creation exits `75` and does not spawn the child.
- [ ] `::phase::` and `::progress::` lines set their fields and are not reported as events.
- [ ] A line longer than 8192 characters is truncated, not rejected.
- [ ] A line containing a token-shaped string is reported with it redacted.
- [ ] Overflowing the queue drops the oldest events and reports how many were lost.
- [ ] A pairing code is exchanged once, and the resulting file is mode `0600`.
- [ ] Neither the token nor the pairing code is written to stdout, stderr, or the token file's directory
      listing beyond the file itself.

### Required Tests

`report.test.mjs`, against a stub HTTP server so no network or real agent is involved:

- `ends the run succeeded and exits zero when the child succeeds`
- `ends the run failed and passes through the child exit code`
- `reports failed and exits 128 plus signal when the child is killed`
- `passes the child stdout through unchanged`
- `heartbeats while the child is silent`
- `runs the child to completion when the API is unreachable`
- `exits 75 without spawning the child when the lane is occupied`
- `consumes phase and progress sentinels without reporting them`
- `truncates a line longer than the column allows`
- `redacts a token-shaped string`
- `drops oldest events and reports the loss when the queue overflows`
- `exchanges a pairing code once and writes the token file with mode 0600`
- `never writes the credential to stdout or stderr`

### Performance Budget

- Reporter overhead under 5% of wall clock on a command producing 10,000 output lines, measured
  against the same command run unwrapped.
- Steady-state memory bounded by the 1000-event queue, so a run producing unbounded output does not
  grow the reporter.

### Out of Scope

- Deriving commit counts, dirty state or pull request status. The reporter reports what the agent does;
  correlating git and GitHub state belongs to the issue that adds cached GitHub polling.
- Any change to Claude Code, Codex or Cursor configuration, and any credential for them. The reporter
  wraps whatever command it is given.
- Parsing agent output for meaning. Only the two sentinels are interpreted.
- Running as a daemon, supervising restarts, or replacing `new-worktree.sh`.
- A Windows shell path. `bash` and `zsh` on macOS and Linux only, matching the rest of `scripts/`.

### Dependencies

- #198 — the endpoints it writes to.
- #199 — the credential and the exchange endpoint.

### Risk Tier

tier:2 — Normal application code. It presents a credential but does not define or store one beyond the file 020 issues.

### Size

size:m

### Verification

```bash
node --test scripts/agent/report.test.mjs
# End to end against a local API, with a trivial child.
INFRACANVAS_WORKSPACE_ID=<id> INFRACANVAS_PAIRING_CODE=<code> \
  scripts/agent/report.mjs --lane smoke --agent other -- sh -c 'echo hello; exit 3'
echo "exit=$?"   # expect 3
stat -f '%Lp' ~/.infracanvas/agent-token   # expect 600
pnpm verify
```
