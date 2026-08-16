---
title: '[web] The lane board: what every agent is doing, live'
labels: tier:2, size:m, area:web, area:api, epic:18-agentops
---

### Epic

#197

### Context

`010` and `020` made the data exist and be writable. Nothing shows it. This is the screen: one row
per lane, what is running in it, what it claimed, and what it last said.

Two constraints shape the design more than the visual does.

**One stream for the board, not one per run.** A browser allows roughly six concurrent connections
per origin over HTTP/1.1, and `EventSource` holds its connection open for the life of the page. A
board that opened one stream per visible run would work at three lanes, stall at seven, and the
failure would look like "some lanes stopped updating" rather than like a connection limit. The server
therefore multiplexes one workspace stream, and each frame names the run it concerns. This is an
addition to `010`'s per-run stream, which stays as it is for a single-run detail view.

**The bundle has about five kilobytes of headroom.** `docs/DELIVERY.md` sets the web budget at 250 KB
gzip of initial JavaScript, ratcheted to 260 KB because the app currently ships 255 KB in one chunk.
A board added to the existing chunk would fail Gate 6, and raising the ratchet to accommodate a new
screen is how a budget stops meaning anything. The route is therefore lazily loaded, so it is a
separate chunk and the initial figure does not move.

**Abandoned has to be visible, because it is the state that wastes time.** A run whose agent died
mid-work still reads `running` in its row: no dead process writes its own terminal status. `010`
computes staleness on read, and this screen has to render that plainly rather than let a silent lane
look busy. Distinguishing "still working" from "stopped reporting" is the reason the board exists.

### Contract

An addition to the API, `apps/api/src/routes/workspaces/agent-runs.ts`:

```
GET /api/workspaces/:workspaceId/agent-runs/stream  -> 200 text/event-stream
```

Frames, each carrying the `agent_run_events.id` it was generated from as the SSE `id:` so the whole
board resumes from one cursor:

```
event: run          data: AgentRun                       # a run started, or its status changed
event: run-event    data: { runId, ...AgentRunEvent }    # a line appended to any run in the workspace
```

Resume, heartbeat, lifetime cap and terminal behaviour follow
`apps/api/src/lib/jobs/progress-stream.ts` unchanged, except that the stream does not close when one
run ends: the board outlives any single run, so it closes only on the lifetime cap.

`apps/web/src/lib/api/agent-runs.ts`:

```ts
export interface AgentRunView {
  id: string;
  agent: 'claude-code' | 'codex' | 'cursor' | 'other';
  lane: string;
  issueNumber: number | null;
  branch: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'abandoned';
  startedAt: string;
  endedAt: string | null;
  lastMessage: string | null;
  lastPhase: string | null;
  progress: number | null;
}

export const agentRunsApi = {
  list(workspaceId: string): Promise<AgentRunView[]>;
  streamUrl(workspaceId: string): string;
};
```

`apps/web/src/lib/hooks/use-agent-runs.ts`:

```ts
/**
 * Seeds from `list`, then applies frames from the single workspace stream.
 * Mirrors `use-analysis-progress.ts`: named `EventSource` listeners, and a
 * `readyState === CLOSED` check to tell a server-ended response from a dropped
 * connection the browser will retry on its own.
 */
export function useAgentRuns(workspaceId: string): {
  runs: AgentRunView[];
  connection: 'connecting' | 'live' | 'reconnecting' | 'closed';
};
```

Components, one responsibility each:

- `apps/web/src/components/agents/LaneBoard.tsx` — the list, grouped by lane, and the connection state.
- `apps/web/src/components/agents/LaneRow.tsx` — one lane: agent, status, claimed issue, branch,
  progress, last line.
- `apps/web/src/components/agents/RunStatusBadge.tsx` — the four statuses, `abandoned` visually
  distinct from both `running` and `failed`.

The route is registered lazily so it lands in its own chunk:

```tsx
const AgentsPage = lazy(() => import('./pages/AgentsPage'));
```

### Files

- `apps/api/src/routes/workspaces/agent-runs.ts` — MODIFY: add the workspace stream.
- `apps/api/src/routes/workspaces/agent-runs.test.ts` — MODIFY: cover it.
- `apps/web/src/lib/api/agent-runs.ts` — NEW.
- `apps/web/src/lib/hooks/use-agent-runs.ts` — NEW.
- `apps/web/src/lib/hooks/use-agent-runs.test.ts` — NEW.
- `apps/web/src/components/agents/LaneBoard.tsx` — NEW.
- `apps/web/src/components/agents/LaneRow.tsx` — NEW.
- `apps/web/src/components/agents/RunStatusBadge.tsx` — NEW.
- `apps/web/src/pages/AgentsPage.tsx` — NEW.
- `apps/web/src/App.tsx` — MODIFY: lazy route.

### Acceptance Criteria

- [ ] The board lists every non-deleted run in the workspace, newest first, one row per run.
- [ ] A run started after the page loaded appears without a reload.
- [ ] A line appended to any run updates that row's last message without a reload.
- [ ] A run that reaches a terminal status updates in place, and the stream stays open.
- [ ] A run whose heartbeat is stale renders as `abandoned`, visually distinct from `running` and `failed`.
- [ ] Exactly one `EventSource` is open for the page regardless of how many runs are shown.
- [ ] A dropped connection reconnects and resumes from the last received id, without duplicating rows.
- [ ] The connection state is shown, so a stalled board is distinguishable from an idle one.
- [ ] Runs from another workspace never appear.
- [ ] Initial gzipped JavaScript does not increase: the board is a separate chunk, verified by the build
      output.
- [ ] Every status is conveyed by text or an accessible label, not by colour alone.

### Required Tests

`use-agent-runs.test.ts`:

- `seeds from the list endpoint`
- `adds a run that arrives on the stream`
- `updates a run in place when its status changes`
- `updates the last message when an event arrives`
- `opens exactly one EventSource for many runs`
- `resumes from the last id after a reconnect`
- `does not duplicate a run replayed after a reconnect`
- `reports the connection state through its lifecycle`

`agent-runs.test.ts` (API, added cases):

- `streams runs and events for one workspace only`
- `keeps the workspace stream open when a run ends`
- `resumes the workspace stream from Last-Event-ID`

### Performance Budget

- Initial gzipped JavaScript unchanged, within the 260 KB ratchet: the board must not be in the entry
  chunk. Verified from `pnpm --filter @infracanvas/web build` output.
- A board of 50 runs re-renders in under 16 ms on an appended event, so a busy workspace holds 60fps.
- One `EventSource` per page, asserted in test rather than assumed.

### Out of Scope

- Pull request and gate status per run. It needs cached GitHub polling, because `gh pr checks` is a
  network call per pull request and a board refreshing every two seconds across a dozen lanes would
  exhaust the rate limit. Its own issue.
- Any control over an agent: no start, stop, or reassignment. Read-only.
- A detail view of one run's full log. `010`'s per-run stream already supports it; the screen is
  separate work.
- Token management UI. `020` deliberately shipped no UI; wiring it in is its own issue.
- The canvas, and the existing analysis progress panel.

### Dependencies

- #198 — the model and the per-run stream.
- #199 — not strictly required to render, but without it no external agent can
  produce a row, so the board has nothing to show.

### Risk Tier

tier:2 — Normal application code. Read-only, and it controls nothing.

### Size

size:m

### Verification

```bash
pnpm --filter @infracanvas/web exec vitest run src/lib/hooks/use-agent-runs.test.ts
pnpm --filter @infracanvas/api exec vitest run src/routes/workspaces/agent-runs.test.ts
# The board must be its own chunk, and the entry chunk must not grow.
pnpm --filter @infracanvas/web build
pnpm verify
```
