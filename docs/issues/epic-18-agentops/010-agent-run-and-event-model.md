---
title: '[api] Agent runs and their event log, streamed live'
labels: tier:2, size:m, area:api, area:db, epic:18-agentops
---

### Epic

#197

### Context

A team running several coding agents against one repository has no way to see what they are doing.
The state exists, but it is scattered: which branch each agent is on lives in a git worktree, what it
claimed lives in a GitHub label, whether its work passes lives in a check run, and whether the agent
is still alive lives only in a process table on whichever machine started it.

Assembling that by hand does not scale past about two agents. Answering "what are my three agents
doing right now" currently means running `git worktree list`, then `git status` and
`git rev-list origin/main..HEAD` per tree, then `gh issue list` for claims, then `gh pr checks` per
pull request, then checking each process by pid — roughly a dozen commands whose output is stale by
the time the last one returns.

The costly gap is not the tedium, it is that **an agent that exited without committing looks exactly
like an agent still thinking.** Both show a dirty worktree, no commits, and no pull request. The
difference is only visible if something recorded that the agent stopped reporting, and nothing does.
Time is lost waiting on a process that is already dead.

This issue adds the durable record that makes such a view possible: a run per agent per lane, and an
append-only event log per run, streamed to a browser as it is written.

It is deliberately the whole foundation and nothing else. No UI, no machine credential, no agent-side
reporter — each of those is its own issue, and each depends on the contract below rather than
inventing its own.

**Why a lane is the unit.** A lane is a set of file paths one agent owns exclusively while it works;
two agents in one lane produce a merge conflict by construction. The database therefore permits one
live run per lane per workspace, so the invariant is enforced where it cannot be forgotten rather
than in a document every agent is trusted to have read.

**Why this reuses the job event log design.** `job_events` already solves the same problem for
analysis jobs: an append-only log keyed by a monotonic `bigserial`, read by the SSE endpoint rather
than by subscribing to the worker, so any API process can serve any run's stream and a reconnecting
client resumes from an id rather than from whatever a worker still holds in memory. The same shape
applies unchanged here, and diverging from it would mean two stream implementations to keep correct.

### Contract

Migration `db/migrations/<timestamp>_agent_runs.sql`:

```sql
-- migrate:up

-- One agent working one lane. A run is the unit an observer watches: it has an
-- agent, a lane, optionally the issue it claimed and the branch it works on, and
-- a status that distinguishes finishing from going silent.
--
-- `text` with a CHECK rather than an ENUM. These value sets grow -- a fourth
-- agent product, a fifth status -- and `ALTER TYPE ... ADD VALUE` has no inverse,
-- so an ENUM cannot be undone inside migrate:down and fails the up/rollback/up
-- round trip Gate 4 runs.
CREATE TABLE agent_runs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent             text        NOT NULL CHECK (agent IN ('claude-code', 'codex', 'cursor', 'other')),
  -- A lane is exclusive file ownership, so it names the work rather than the tool.
  lane              text        NOT NULL CHECK (length(lane) BETWEEN 1 AND 64),
  issue_number      integer     CHECK (issue_number IS NULL OR issue_number > 0),
  branch            text        CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 255),
  worktree_path     text        CHECK (worktree_path IS NULL OR length(worktree_path) <= 1024),
  status            text        NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
  -- Going silent is not finishing. An agent that dies mid-run never writes a
  -- terminal status, so liveness has to be observed rather than reported, and a
  -- reader compares this against its own clock to tell the two apart.
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One live run per lane per workspace. Partial, so a finished run does not block
-- the next agent from taking the lane, and so the constraint expresses the actual
-- rule: lanes are exclusive while occupied, reusable afterwards.
CREATE UNIQUE INDEX agent_runs_live_lane_idx
  ON agent_runs (workspace_id, lane) WHERE status = 'running';

-- The board's query: a workspace's runs, newest first.
CREATE INDEX agent_runs_workspace_idx ON agent_runs (workspace_id, started_at DESC);

CREATE TRIGGER agent_runs_set_updated_at
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What a run reported while it ran.
--
-- A monotonic bigserial rather than a timestamp, because the id is the cursor a
-- reconnecting stream resumes from: two events written in the same millisecond
-- have an unambiguous order, and Last-Event-ID is a cursor, not a clock.
CREATE TABLE agent_run_events (
  id       bigserial   PRIMARY KEY,
  run_id   uuid        NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  level    text        NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message  text        NOT NULL CHECK (length(message) BETWEEN 1 AND 8192),
  -- A coarse phase label, so a board can show "running tests" without parsing
  -- prose. Null when the line reports no phase.
  phase    text        CHECK (phase IS NULL OR length(phase) <= 64),
  -- 0 to 1, or null for a log line that reports no advance.
  progress real        CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1))
);

CREATE INDEX agent_run_events_run_idx ON agent_run_events (run_id, id);

-- migrate:down

DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS agent_runs;
```

`apps/api/src/lib/db/agent-runs.ts`:

```ts
export type AgentKind = 'claude-code' | 'codex' | 'cursor' | 'other';
export type AgentRunStatus = 'running' | 'succeeded' | 'failed' | 'abandoned';
export type EventLevel = 'info' | 'warn' | 'error';

export interface AgentRun {
  id: string;
  workspaceId: string;
  agent: AgentKind;
  lane: string;
  issueNumber: number | null;
  branch: string | null;
  worktreePath: string | null;
  status: AgentRunStatus;
  lastHeartbeatAt: Date;
  startedAt: Date;
  endedAt: Date | null;
}

export interface AgentRunEvent {
  id: number;
  runId: string;
  at: Date;
  level: EventLevel;
  message: string;
  phase: string | null;
  progress: number | null;
}

export interface StartAgentRunInput {
  workspaceId: string;
  agent: AgentKind;
  lane: string;
  issueNumber?: number;
  branch?: string;
  worktreePath?: string;
}

/** Rejects with `LaneOccupiedError` when the lane already has a live run. */
export async function startAgentRun(input: StartAgentRunInput): Promise<AgentRun>;

export class LaneOccupiedError extends Error {
  readonly lane: string;
  readonly existingRunId: string;
}

export async function heartbeatAgentRun(id: string): Promise<void>;

/** Terminal statuses only; sets `ended_at`. Idempotent for an already-ended run. */
export async function endAgentRun(
  id: string,
  status: Exclude<AgentRunStatus, 'running'>
): Promise<void>;

export async function appendAgentRunEvent(input: {
  runId: string;
  level: EventLevel;
  message: string;
  phase?: string;
  progress?: number;
}): Promise<AgentRunEvent>;

export async function findAgentRun(id: string): Promise<AgentRun | null>;

/**
 * A workspace's runs, newest first. `status` is computed, not read: a run still
 * marked `running` whose heartbeat is older than `staleAfterMs` is reported as
 * `abandoned`, because that is what an observer needs to know and no dead agent
 * will ever write the row itself.
 */
export async function listAgentRuns(
  workspaceId: string,
  options?: { limit?: number; staleAfterMs?: number }
): Promise<AgentRun[]>;

export async function readAgentRunEvents(
  runId: string,
  options?: { afterId?: number; limit?: number }
): Promise<AgentRunEvent[]>;
```

`apps/api/src/routes/workspaces/agent-runs.ts`, all behind the existing `requireAuth` and scoped to a
workspace the caller may see:

```
POST   /api/workspaces/:workspaceId/agent-runs        -> 201 AgentRun | 409 lane occupied
GET    /api/workspaces/:workspaceId/agent-runs        -> 200 AgentRun[]
POST   /api/agent-runs/:id/heartbeat                  -> 204
POST   /api/agent-runs/:id/events                     -> 201 AgentRunEvent
PATCH  /api/agent-runs/:id                            -> 200 AgentRun   (status only)
GET    /api/agent-runs/:id/events/stream              -> 200 text/event-stream
```

The stream follows `apps/api/src/lib/jobs/progress-stream.ts` exactly: `id:` frames carrying the
event `bigserial`, resume via `Last-Event-ID` or `?lastEventId=`, comment-frame heartbeats so a proxy
does not close an idle stream, a cap on stream lifetime, and a close once the run reaches a terminal
status. Unparseable resume cursors replay from the beginning rather than skipping.

### Files

- `db/migrations/<timestamp>_agent_runs.sql` — CREATE: the DDL above.
- `apps/api/src/lib/db/agent-runs.ts` — CREATE: the functions above.
- `apps/api/src/lib/db/agent-runs.integration.test.ts` — CREATE: the database tests below.
- `apps/api/src/routes/workspaces/agent-runs.ts` — CREATE: the routes above.
- `apps/api/src/routes/workspaces/agent-runs.test.ts` — CREATE: the route tests below.
- `apps/api/src/routes/index.ts` — MODIFY: mount the router.

### Acceptance Criteria

- [ ] Starting a run in a free lane returns the run with `status = 'running'`.
- [ ] Starting a second run in a lane that already has a live run fails, and does not create a row.
- [ ] Starting a run in a lane whose previous run has ended succeeds.
- [ ] A run belonging to another workspace is not returned by `listAgentRuns`, and its stream returns 404.
- [ ] `listAgentRuns` reports a run as `abandoned` when it is still marked `running` and its heartbeat is
      older than `staleAfterMs`, without writing to the row.
- [ ] `heartbeatAgentRun` moves `last_heartbeat_at` forward and leaves `status` untouched.
- [ ] `endAgentRun` sets `ended_at` and is a no-op when the run has already ended.
- [ ] Appending an event returns a strictly greater id than the previous event for that run.
- [ ] The stream replays existing events, then delivers new ones as they are appended.
- [ ] A stream reconnecting with `Last-Event-ID` receives only events after that id.
- [ ] A stream given a malformed `Last-Event-ID` replays from the first event.
- [ ] The stream closes once the run reaches a terminal status.
- [ ] Deleting a workspace deletes its runs and their events.
- [ ] A `progress` outside 0 to 1, an unknown `level`, an unknown `agent`, or an unknown `status` is
      rejected rather than stored.
- [ ] The migration applies, rolls back, and applies again cleanly.

### Required Tests

`agent-runs.integration.test.ts`:

- `starts a run and reports it as running`
- `refuses a second live run in the same lane`
- `allows a new run in a lane whose previous run ended`
- `keeps two workspaces' runs separate`
- `reports a run with a stale heartbeat as abandoned without writing to it`
- `advances the heartbeat without changing status`
- `ends a run once, and ignores a second end`
- `assigns strictly increasing event ids per run`
- `reads only events after a cursor`
- `deletes runs and events when the workspace is deleted`
- `rejects a progress value outside zero to one`
- `rejects an unknown agent, level, and status`
- `migration rolls back cleanly`

`agent-runs.test.ts`:

- `returns 409 when the lane is occupied`
- `returns 404 for a run in a workspace the caller cannot see`
- `requires authentication`
- `replays existing events then streams new ones`
- `resumes from Last-Event-ID`
- `replays from the start when Last-Event-ID is malformed`
- `closes the stream when the run ends`

### Performance Budget

- `listAgentRuns` for a workspace with 10,000 runs: an index scan on
  `agent_runs_workspace_idx`, server-side execution under 10 ms, asserted with
  `EXPLAIN (ANALYZE, FORMAT JSON)`.
- An appended event appears on an open stream within 1.5 s, which the polling interval bounds.

### Out of Scope

Each of these depends on the contract above and is its own issue. Do not start any of them here, and
in particular do not add a credential — that is the whole of `020` and it changes the risk tier.

- **`020-agent-ingest-tokens.md`** — the workspace-scoped machine credential that lets an external
  agent report without a browser session. Tier 1, because it is a credential. Until it lands, runs
  are written by an authenticated session, which is enough to test and demonstrate the model.
- **`030-lane-board.md`** — the web view. `apps/web` is untouched here.
- **`040-agent-reporter.md`** — the wrapper that makes Claude Code, Codex and Cursor emit these
  events, including deriving branch and commit state from the worktree.
- **Correlating a run with its pull request and gate status.** It needs GitHub polling with a cache,
  because `gh pr checks` is a network call per pull request and a board refreshing every two seconds
  across a dozen lanes would exhaust the API rate limit.
- Reaping abandoned runs on a timer. Staleness is computed on read here, which needs no scheduler.
- `job_events`, `jobs`, and the analysis progress stream. This mirrors their design; it does not
  modify them.

### Dependencies

- #190 — `workspaces` must exist, since `workspace_id` is a foreign key to it.
- `epic-0-delivery/160-extend-epic-seeding-to-seventeen.md` — must be extended to eighteen, since
  `.github/labels.yml`, `seed-epics.mjs` and `seed-milestones.mjs` stop at 12 and this epic has
  neither a label nor a tracking issue.

### Risk Tier

tier:2 — Normal application code: new tables and endpoints, no credential and no IAM path.

### Size

size:m

### Verification

```bash
pnpm db:migrate && pnpm db:rollback && pnpm db:migrate
pnpm --filter @infracanvas/api exec vitest run src/lib/db/agent-runs.integration.test.ts \
  --config vitest.integration.config.ts
pnpm --filter @infracanvas/api exec vitest run src/routes/workspaces/agent-runs.test.ts
pnpm verify
```
