---
title: '[web] Copilot chat docked beside the canvas with diff cards and accept or reject'
labels: tier:2, size:l, area:web, epic:13-agent
---

### Epic

#117

### Context

The designer today is `apps/web/src/components/designer/DesignerCanvas.tsx`: a palette on the left, the
React Flow canvas in the middle, `PropertiesPanel` on the right and `CodePanel` along the bottom. There
is nowhere to say anything. This issue adds the chat, and it docks it beside the canvas rather than
putting it in a modal or on its own route for one reason: the answer to "make the database highly
available" is a change to specific boxes, and the user has to see those boxes light up while they read
why. A modal covers the thing under discussion, and a separate page turns "which nodes does this touch"
into an act of memory.

**Tool calls are rendered as what the copilot is doing, never as JSON.** An accordion containing
`{"op":"set_param","nodeId":"database-primary","param":"multiAz","value":true}` looks like transparency
and is not: it makes the user read a serialisation format to find out that the copilot priced a change
to their database. Every tool call arrives with a `summary` sentence built by the tool layer in
`040-conversation-run-loop.md`, and that sentence is what the row shows. Expanding a proposal shows its
operations as sentences too -- "Set multiAz to true on database-primary" -- because the operation list is
the reviewable artefact and a JSON blob is not reviewable.

**The canvas is never mutated by a proposal, only by an acceptance, and never by the client.** Rejecting
leaves the architecture exactly as it was because nothing was applied: the diff card is rendered from the
`PatchPreview` in the event, and the designer store is untouched until the accept request returns. On
acceptance the client does not apply the patch locally either. It takes the IR document the server
returns, converts it with `irToCanvas` from #79, and loads it, so what is on screen is what is in
`experiments.ir` rather than a client-side replay that could drift from it.

**No markdown library.** The obvious move is `react-markdown`, and it was rejected on two counts. It is
a new dependency in a bundle governed by a hard budget, and it is an HTML pipeline fed by text a language
model produced, which means the safe configuration matters and the unsafe one is one prop away. The
prompt permits prose, inline code, short fenced blocks and citation markers, so a 60-line tokeniser
covers the output exactly, renders into React elements with no `dangerouslySetInnerHTML` anywhere, and is
testable without a DOM.

**The bundle budget is 215 KB gzip of initial JavaScript**, asserted by the `bundle-size` job in
`.github/workflows/gate-perf.yml` as `node scripts/ci/check-bundle-size.mjs apps/web/dist 215`.
`scripts/ci/check-bundle-size.mjs` counts only the entry chunks referenced from `index.html`, and its
header says why: pushing weight behind a dynamic import is the behaviour the budget exists to encourage.
So the chat stays outside the number by construction. `DesignerPage` is already `lazy()` in
`apps/web/src/App.tsx`, the copilot panel is a second `lazy()` boundary inside it so that a user who
never opens the chat never downloads it, and the panel adds no dependency to `apps/web/package.json`. The
verification below runs the gate's own command rather than asserting the budget in prose.

Component tests are not part of this issue, and that is a deliberate continuation of an existing
decision rather than an omission. `apps/web/vitest.config.ts` includes only `src/**/*.test.ts` and its
comment explains the rule: logic that needs testing lives under `src/lib` so that a DOM and a testing
library are unnecessary. This issue follows it -- the store, the stream parser, the tokeniser, the
label mapper and the delta formatter are all pure and all tested -- and the components stay thin enough
that there is nothing left in them to assert.

Spec: `docs/issues/epic-13-agent/050-copilot-sse-endpoint.md`

### Contract

```typescript
// apps/web/src/lib/copilot/sse-client.ts
export interface TurnHandlers {
  onEvent(event: CopilotEvent): void;
  /** Called once, with a code the UI can branch on, when the turn cannot start. */
  onRefusal(refusal: { status: number; code: string; message: string }): void;
  onClose(finish: 'complete' | 'limit' | 'cancelled' | 'error'): void;
}

/**
 * Starts a turn. A POST cannot be an `EventSource`, so the stream is read from
 * `fetch` with a `ReadableStream`; frames are reassembled across chunk
 * boundaries, which is the bug every hand-rolled SSE reader has.
 *
 * Returns an abort function. Aborting closes the request, which is what makes
 * the server cancel the run rather than finish it into a void.
 */
export function startTurn(
  experimentId: string,
  message: string,
  handlers: TurnHandlers,
  signal: AbortSignal
): Promise<void>;

/**
 * Reattaches to a turn after a dropped connection, using `EventSource` on the
 * GET route so the browser's own reconnection and `Last-Event-ID` handling do
 * the work. The first event is a `snapshot` that replaces the local message.
 */
export function resumeTurn(
  experimentId: string,
  messageId: string,
  handlers: TurnHandlers
): () => void;
```

```typescript
// apps/web/src/lib/stores/copilot-store.ts
export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallView[];
  citations: CitationView[];
  proposal: ProposalView | null;
  status: 'streaming' | 'complete' | 'limit' | 'cancelled' | 'error';
  unverifiedCitations: number;
}

export interface ProposalView {
  proposalId: string;
  summary: string;
  operations: string[]; // already rendered as sentences
  touchedNodeIds: string[];
  preview: PatchPreview;
  decision: 'pending' | 'accepted' | 'rejected' | 'stale';
}

export interface CopilotState {
  isOpen: boolean;
  messages: CopilotMessage[];
  /** IR node ids the pending proposal touches. Empty when nothing is pending. */
  highlightedNodeIds: string[];
  streamingMessageId: string | null;
  refusal: { code: string; message: string } | null;

  open(): void;
  close(): void;
  loadTranscript(messages: CopilotMessage[]): void;
  /** Applies one event. The only way a message changes. */
  applyEvent(event: CopilotEvent): void;
  /** Replaces the streaming message wholesale, for a resume snapshot. */
  applySnapshot(message: CopilotMessage): void;
  decideProposal(proposalId: string, decision: 'accepted' | 'rejected'): void;
  reset(): void;
}
```

`applyEvent` is the single reducer, which is what makes the whole surface testable: a recorded event
sequence played into the store must produce the message the transcript endpoint would have returned for
the same turn, and that equivalence is one of the required tests.

```typescript
// apps/web/src/lib/copilot/tool-labels.ts
/**
 * The fallback matters more than the table. An unknown tool renders as its name
 * in a sentence rather than as JSON, so #118 adding a tool degrades to plain
 * English instead of leaking a payload into the UI.
 */
export function describeToolCall(call: ToolCallView): string;

/** `+$31.40 / mo`, `-$212.00 / mo`, `no change`, or `at least +$31.40 / mo` when partial. */
export function formatCostDelta(delta: CostDelta): string;

/** `99.95% -> 99.99%`, with `21.6 min -> 4.3 min of monthly downtime`. */
export function formatAvailabilityDelta(delta: AvailabilityDelta): string;
```

```typescript
// apps/web/src/lib/copilot/render.ts
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'block'; language: string | null; text: string }
  | { kind: 'citation'; scheme: 'file' | 'sku' | 'prediction'; target: string; verified: boolean };

/** Splits assistant text into segments. Never produces HTML. */
export function segments(text: string, citations: CitationView[]): Segment[];
```

Components, one responsibility each, in `apps/web/src/components/copilot/`:

| Component         | Responsibility                                                                       |
| ----------------- | ------------------------------------------------------------------------------------ |
| `CopilotPanel`    | The dock: header, scroll region, composer, and the not-configured state              |
| `MessageList`     | Ordered messages, autoscroll that stops when the user scrolls up                     |
| `MessageBubble`   | One message, rendered from `segments`                                                |
| `CitationChip`    | A verified citation as a link, an unverified one as a marked, unlinked claim         |
| `ToolCallRow`     | One line of what the copilot is doing, with a spinner until its result arrives       |
| `PatchDiffCard`   | Summary, operations, cost and availability deltas, findings, accept and reject       |
| `DeltaBadge`      | One signed figure with its unit, and the partial marker when completeness is partial |
| `CopilotComposer` | Textarea, Enter to send, Shift and Enter for a newline, Stop while streaming         |

The panel is docked to the right of the canvas and above `PropertiesPanel` in the same column, collapsed
to a button on a viewport under 768px, matching how `DesignerCanvas` already treats `ServicePalette` on
mobile.

Highlighting is read by the node component rather than pushed through the designer store:
`ServiceNode` subscribes to `highlightedNodeIds` and draws a ring when its own id is in the set, so a
proposal re-renders the touched nodes and nothing else, and `designer-store.ts` keeps a single writer.
Canvas node ids equal IR node ids once #79's round trip lands, which this issue depends on; a touched id
with no matching canvas node is ignored rather than throwing, because a proposal may name a node the
canvas cannot render.

```
POST   /api/experiments/:id/copilot/messages                       -> SSE stream
GET    /api/experiments/:id/copilot                                -> transcript
GET    /api/experiments/:id/copilot/messages/:messageId/events      -> resume
POST   /api/experiments/:id/copilot/proposals/:proposalId/accept    -> { ir, irDigest }
POST   /api/experiments/:id/copilot/proposals/:proposalId/reject    -> 204
```

The 409 with `code: 'no_llm_credential'` renders as a card inside the panel with a link to `/settings`,
not as a toast. A toast is the wrong shape for a state that will still be true in five minutes, and the
existing `Toaster` is for things that have happened rather than things that need doing.

### Files

- CREATE `apps/web/src/components/copilot/CopilotPanel.tsx`
- CREATE `apps/web/src/components/copilot/MessageList.tsx`
- CREATE `apps/web/src/components/copilot/MessageBubble.tsx`
- CREATE `apps/web/src/components/copilot/CitationChip.tsx`
- CREATE `apps/web/src/components/copilot/ToolCallRow.tsx`
- CREATE `apps/web/src/components/copilot/PatchDiffCard.tsx`
- CREATE `apps/web/src/components/copilot/DeltaBadge.tsx`
- CREATE `apps/web/src/components/copilot/CopilotComposer.tsx`
- CREATE `apps/web/src/components/copilot/NotConfiguredCard.tsx`
- CREATE `apps/web/src/components/copilot/index.ts` - barrel export, matching `designer/index.ts`
- CREATE `apps/web/src/lib/copilot/sse-client.ts`
- CREATE `apps/web/src/lib/copilot/tool-labels.ts`
- CREATE `apps/web/src/lib/copilot/render.ts`
- CREATE `apps/web/src/lib/copilot/types.ts` - the event and view types the store and client share
- CREATE `apps/web/src/lib/stores/copilot-store.ts`
- CREATE `apps/web/src/lib/api/copilot.ts` - transcript, accept and reject through `apiFetch`
- CREATE `apps/web/src/lib/hooks/use-copilot.ts` - transcript query plus the turn lifecycle
- CREATE `apps/web/src/lib/copilot/sse-client.test.ts`
- CREATE `apps/web/src/lib/copilot/render.test.ts`
- CREATE `apps/web/src/lib/copilot/tool-labels.test.ts`
- CREATE `apps/web/src/lib/stores/copilot-store.test.ts`
- CREATE `apps/web/src/lib/copilot/__fixtures__/turn.events.json` - a recorded turn, including a proposal
- MODIFY `apps/web/src/components/designer/DesignerCanvas.tsx` - dock the lazily loaded panel and its toggle
- MODIFY `apps/web/src/components/designer/ServiceNode.tsx` - draw the highlight ring
- MODIFY `apps/web/src/components/designer/DesignerToolbar.tsx` - the button that opens the panel

### Acceptance Criteria

- [ ] `pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215` passes, and the reported initial JavaScript figure is unchanged from before this issue to within 1 KB
- [ ] The copilot panel is behind its own dynamic import, so opening the designer without opening the chat downloads no copilot chunk
- [ ] No new entry in `apps/web/package.json` dependencies
- [ ] Assistant text appears while the turn is still streaming, not after `done`
- [ ] A tool call renders as a sentence, and no view in the panel renders tool arguments, an operation object, or any JSON
- [ ] A proposed patch renders a card with its cost delta, its availability delta, the findings that appeared and were resolved, and accept and reject controls
- [ ] A preview with `completeness: 'partial'` renders as a bound with the count of unpriced resources, never as an exact figure
- [ ] Rejecting a proposal leaves the designer store byte-identical, asserted by comparing a serialised snapshot before and after
- [ ] Rejecting a proposal clears the highlight and marks the card rejected, and the card cannot be accepted afterwards
- [ ] Accepting a proposal replaces the canvas from the IR the server returned rather than from a locally applied patch
- [ ] While a proposal is pending, exactly the nodes in `touchedNodeIds` draw a highlight ring
- [ ] A touched node id that no canvas node matches is ignored without an error
- [ ] An unverified citation renders as an unlinked, marked claim, and a verified one as a link
- [ ] A 409 with `no_llm_credential` renders a persistent card linking to the settings page, and the composer stays disabled
- [ ] The Stop button aborts the request, and the message ends as `cancelled` with the text it had
- [ ] The composer is disabled while a turn is streaming, so a second turn cannot be started into the 409 the server would return
- [ ] Autoscroll stops once the user scrolls up and resumes when they return to the bottom
- [ ] Playing the recorded event fixture into the store produces the same message the transcript endpoint returns for that turn

### Required Tests

- `reassembles an event split across two stream chunks`
- `reassembles a frame whose data field arrives before its id`
- `reports a refusal status without emitting any event`
- `stops reading when the abort signal fires`
- `appends streaming tokens to the open message only`
- `replaces the open message when a snapshot arrives`
- `records a proposal against the message that produced it`
- `clears the highlight when a proposal is rejected`
- `refuses a second decision on an already decided proposal`
- `builds the same message from the recorded fixture as the transcript returns`
- `describes an unknown tool by name rather than by payload`
- `formats a partial cost delta as a lower bound`
- `formats an unchanged cost delta as no change`
- `formats availability as a percentage pair and a downtime pair`
- `splits a fenced code block out of assistant prose`
- `renders an unverified citation as unverified`
- `produces no html from assistant text containing a script tag`

### Performance Budget

Initial JavaScript stays at or under 215 KB gzip, which is the number
`.github/workflows/gate-perf.yml` enforces; the copilot chunk itself is under 40 KB gzip and is fetched
only when the panel opens. Token events are coalesced into at most one store update per animation
frame, so a 40-events-per-second stream causes about 60 renders a second rather than 40 store writes
plus 40 list re-renders; asserted by counting subscriber notifications in the store test at a simulated
1000 events. The message list renders only the message that changed, so a 200-message transcript does
not re-render on every token.

### Out of Scope

- Do not add `@testing-library/react`, `jsdom`, or component tests. `apps/web/vitest.config.ts` states
  the rule and this issue keeps the logic in `src/lib` so the rule still holds
- Do not add a markdown or sanitiser dependency. `render.ts` covers the output the prompt permits
- Do not apply patches in the browser. `applyPatch` is server-side, and the canvas is reloaded from the
  IR the accept response returns
- Do not migrate `designer-store.ts` to the IR types. That is the web epic's job (#12), and doing it here
  turns a chat panel into a canvas rewrite
- Do not add an undo button for an applied patch. The inverse patch is stored by
  `020-copilot-tool-surface.md`, and exposing it is its own issue with its own product question about
  what undo means after further edits
- Do not surface conversation history across experiments, search, or export
- Do not render the raw IR, the patch JSON, or a JSON diff anywhere in the panel, including behind a
  developer toggle. A JSON view is what this design replaces
- Do not touch `CodePanel`, `PropertiesPanel` or `ServicePalette` beyond the layout change needed to dock
  the panel

### Dependencies

Blocked by `050-copilot-sse-endpoint.md` for every route and the event shapes, `030-patch-preview-deltas.md`
for `PatchPreview` and its delta types, and #79 for `irToCanvas` and for canvas node ids matching IR node
ids. #61 has landed, so the settings page the not-configured card links to already exists.

### Verification

```bash
pnpm --filter @infracanvas/web test
pnpm --filter @infracanvas/web typecheck
pnpm --filter @infracanvas/web build
node scripts/ci/check-bundle-size.mjs apps/web/dist 215
ls -l apps/web/dist/assets | grep -i copilot   # the chunk exists and is separate
pnpm lint
```

Manually, with the API and the brain running and a credential configured: open a designer with an
analysed architecture, ask for the database to be made highly available, watch the tool rows and the
text stream, confirm the touched node lights up, reject and confirm the canvas is untouched, ask again
and accept, and confirm the canvas matches the architecture after a page reload. Then remove the default
credential and confirm the panel explains what to do rather than failing.

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines
