---
title: '[api] Job worker runtime and server-sent progress stream'
labels: tier:2, size:m, area:api, epic:1-data
---

### Epic

#2

### Context

The queue stores work; this issue runs it and shows it to the user. Ingesting a repository takes
minutes, and a progress bar that only moves when the whole thing finishes is indistinguishable from
a hang.

Server-sent events rather than websockets: the traffic is one-directional, SSE survives proxies that
mangle websocket upgrades, and the browser reconnects on its own. The reconnect is why `readEvents`
takes an `afterId` - a client that drops mid-ingestion resumes from where it stopped rather than
replaying several thousand log lines.

The worker runs in the API process for now. Splitting it into its own deployable is easy later
because it talks to the queue over SQL and shares nothing else, and doing it now would mean
operating two services before there is any load to justify it.

Spec: `docs/DATABASE.md`

### Contract

```typescript
export interface JobHandler<P = unknown> {
  readonly kind: string;
  /** Long-running work. Call `ctx.progress` to report; check `ctx.signal` to stop promptly. */
  handle(payload: P, ctx: JobContext): Promise<void>;
}

export interface JobContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  progress(fraction: number, message: string): Promise<void>;
  log(level: 'info' | 'warn' | 'error', message: string): Promise<void>;
}

export class Worker {
  constructor(options: WorkerOptions);
  register(handler: JobHandler): void;
  start(): void;
  /** Stops claiming, waits for in-flight jobs, then resolves. */
  stop(): Promise<void>;
}

export interface WorkerOptions {
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
}
```

Route: `GET /experiments/:id/events` streams `text/event-stream`, replaying from the `Last-Event-ID`
header when present and emitting a comment line every 15 seconds to keep intermediaries from closing
an idle connection.

### Files

- CREATE `apps/api/src/lib/jobs/worker.ts`
- CREATE `apps/api/src/lib/jobs/context.ts`
- CREATE `apps/api/src/routes/experiments/events.ts`
- CREATE `apps/api/src/lib/jobs/worker.integration.test.ts`
- MODIFY `apps/api/src/index.ts` - start the worker and stop it during shutdown

### Acceptance Criteria

- [ ] A registered handler runs when a job of its kind is enqueued
- [ ] The lease is extended by a heartbeat while a handler is still running
- [ ] A handler that throws marks the job failed with the error message recorded
- [ ] A handler that throws is retried until `max_attempts`
- [ ] `stop()` waits for in-flight handlers rather than abandoning them mid-write
- [ ] `stop()` aborts the context signal so a cooperative handler can exit early
- [ ] Concurrency is respected: with `concurrency: 2`, at most two handlers run at once
- [ ] The SSE route replays from `Last-Event-ID` and does not resend earlier events
- [ ] The SSE route emits a keepalive within 20 seconds on an idle stream
- [ ] The SSE route refuses an experiment belonging to another user

### Required Tests

- `runs a handler for a matching job kind`
- `extends the lease while the handler is still running`
- `marks the job failed and records the error when the handler throws`
- `retries a failing handler until max attempts`
- `waits for in flight handlers on stop`
- `aborts the context signal on stop`
- `never exceeds the configured concurrency`
- `resumes an event stream from Last-Event-ID`
- `emits a keepalive on an idle stream`
- `refuses to stream another user's experiment`

### Performance Budget

An idle worker uses under 1% CPU. Poll interval defaults to 1000ms, so an enqueued job starts within
one second. A streaming connection holds under 1MB of heap.

### Out of Scope

- Do not implement any concrete job handler; ingestion and codegen handlers are their own issues
- Do not add a separate worker deployment or process manager
- Do not use websockets

### Dependencies

Blocked by #28.

### Verification

```bash
pnpm --filter @infracanvas/api test:integration
curl -N -H 'Accept: text/event-stream' localhost:3001/experiments/$ID/events
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
