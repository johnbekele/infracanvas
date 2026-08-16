---
title: '[web] Experiment workspace with a revision timeline you can move through'
labels: tier:2, size:l, area:web, epic:11-ui
---

### Epic

#12

### Context

`apps/web/src/lib/stores/designer-store.ts` is one global canvas. It holds `nodes`, `edges`,
`designName`, `designId`, `isDirty` and `lastSaved` in a single Zustand store, persisted to
`localStorage` under `infracanvas-designer-v1` by the `persist` middleware, and `DesignerPage` renders
`DesignerCanvas` against it with no identifier in the route. Two experiments cannot be open in it,
one after the other leaves the previous one's nodes behind until `clearCanvas` is called, and the
`onRehydrateStorage` hook already carries a version check whose job is to throw away a canvas that no
longer matches the code -- which is what happens when the only copy of a user's architecture lives in
a browser.

This issue makes the canvas a view of an experiment revision. The document authority moves to the
server's `experiment_revisions` chain, the store becomes per-experiment and is seeded from a revision
rather than from storage, and `persist` is reduced to the things that are genuinely local
preferences: the open panel, the active tab, and the Pulumi language. Keeping the canvas persisted as
well was considered as an offline affordance and rejected: a locally persisted architecture that
disagrees with the head revision is one the user has already been shown a cost for, and there is no
correct way to reconcile it on load. Losing an unsaved local edit on a refresh is a smaller harm than
silently resurrecting one over a revision someone else -- or the copilot -- has since appended.

**Selecting an older revision makes the canvas read-only until you branch from it.** The chain is
append-only and a revision's parent is its immediate predecessor, so an edit made while viewing
`seq` 3 of a 7-revision experiment has no valid parent: it is neither a child of 3, which already has
one, nor a child of 7, which it was not derived from. Two alternatives were considered. Auto-forking
on the first keystroke was rejected because the fork would be silent and the user would not know
which of two experiments they are now editing, which is precisely the confusion this whole epic is
built to remove. Allowing the edit and rebasing it onto the head was rejected because a rebase over
an architecture is a merge, and a merge of two architectures with no conflict story produces a
document nobody drew. So history is a read-only mode with one exit: `Branch from this revision`,
which calls `POST /experiments/:id/fork` with `fromRevisionId` and navigates to the new experiment.
Returning to the head is the other exit, and it is one click away at all times.

The panels around the canvas state where their numbers came from rather than printing figures.
Predictions arrive inside the `Prediction<T>` envelope from #101, whose `label: 'Predicted'` is a
literal precisely so no renderer can omit it, and a measured SLI from #71 carries
`confidence: 'measured' | 'partial'`. This page renders both and never computes either.

Spec: `docs/issues/epic-11-web/050-experiment-rest-api.md`

### Contract

The page is `/experiments/:id`, four regions around one canvas:

```
+---------------------------------------------------------------+
| name - hypothesis - status - verdict - deploy / destroy        |  header
+------------+--------------------------------------+-----------+
| revision   |                                      | prediction|
| timeline   |            canvas (React Flow)       | summary   |
| seq 7 head |                                      | + measured|
| seq 6 ...  |                                      | + findings|
+------------+--------------------------------------+-----------+
```

```typescript
// apps/web/src/lib/stores/experiment-store.ts
import type { Edge, Node } from 'reactflow';
import type { CanvasGraph, IrNodeData } from '@infracanvas/core';
import type {
  ExperimentRevision,
  JsonPatchOperation,
  RevisionSummary,
} from '@/lib/api/experiments';

/** `history` disables every mutating action below and every editing affordance. */
export type WorkspaceMode = 'edit' | 'history';

export interface ExperimentWorkspaceState {
  /** Null before `openExperiment`. The store holds one workspace at a time. */
  experimentId: string | null;
  head: RevisionSummary | null;
  /** The revision the canvas currently shows. Equals `head.id` in `edit` mode. */
  selectedRevisionId: string | null;
  mode: WorkspaceMode;

  nodes: Node<IrNodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;

  /** Ops accumulated since `selectedRevisionId`. Empty means nothing to commit. */
  pendingOps: JsonPatchOperation[];
  isDirty: boolean;

  /** Replaces the workspace wholesale. Called on mount and on experiment change. */
  openExperiment(experimentId: string, revision: ExperimentRevision, head: RevisionSummary): void;
  /** Enters `history` when the revision is not the head, `edit` when it is. */
  selectRevision(revision: ExperimentRevision, head: RevisionSummary): void;
  /** Discards pending ops after confirmation and returns to `edit` on the head. */
  returnToHead(revision: ExperimentRevision, head: RevisionSummary): void;
  /** Clears everything, so leaving one experiment cannot leak nodes into the next. */
  closeExperiment(): void;

  /** The document to send with the next revision. Throws in `history` mode. */
  toIr(): CanvasGraph;
}
```

Every mutating action the current store exposes -- `onNodesChange`, `onEdgesChange`, `onConnect`,
`addNode`, `removeNode`, `updateNodeData`, `updateNodeProperty`, `reparentNode`, `resizeNode`,
`removeNodeWithChildren` -- moves onto this store unchanged in behaviour and gains one rule: in
`history` mode each is a no-op that records nothing, rather than a mutation the UI happens not to
offer. Disabling only the buttons was rejected because keyboard delete, drag and the React Flow
selection handlers all reach the store without passing a button.

`designer-store.ts` is reduced to the state that is genuinely a local preference and keeps its
`persist` wrapper:

```typescript
// apps/web/src/lib/stores/designer-store.ts -- after this issue
export interface DesignerViewState {
  isPanelOpen: boolean;
  activeTab: 'properties' | 'terraform' | 'pulumi';
  pulumiLanguage: PulumiLanguage;
  setPanelOpen(open: boolean): void;
  setActiveTab(tab: 'properties' | 'terraform' | 'pulumi'): void;
  setPulumiLanguage(language: PulumiLanguage): void;
}
```

The persisted key moves to `infracanvas-designer-v2` and the rehydration hook drops the node repair
logic, which existed only to fix canvases that had been stored. Bumping the key is what stops a
stored v1 canvas being read back as a preferences object.

```typescript
// apps/web/src/lib/hooks/use-experiments.ts -- added to the file from 060
export function useExperiment(id: string | undefined): UseQueryResult<ExperimentResponse>;
export function useRevisions(id: string | undefined): UseQueryResult<RevisionSummary[]>;
export function useRevision(
  experimentId: string | undefined,
  revisionId: string | undefined
): UseQueryResult<ExperimentRevision>;

/**
 * Appends a revision from the current canvas. On 409 it does not retry: the
 * mutation surfaces `RevisionConflictResponse` so the page can show what moved.
 */
export function useCommitRevision(
  experimentId: string
): UseMutationResult<ExperimentRevision, ApiError, { summary: string }>;

export function useBranchFromRevision(
  experimentId: string
): UseMutationResult<{ experiment: ExperimentListItem }, ApiError, { fromRevisionId: string }>;
```

The timeline entry, one per revision, drawn from `RevisionSummary` and nothing else:

```typescript
// apps/web/src/components/experiment/RevisionTimeline.tsx
export interface RevisionTimelineProps {
  revisions: RevisionSummary[];
  selectedRevisionId: string | null;
  headRevisionId: string | null;
  onSelect(revisionId: string): void;
  onBranch(revisionId: string): void;
}
```

Each entry shows `seq`, the summary line, relative time, the operation count, and an author badge
that distinguishes the three cases the schema records:

| `author_kind` | `source`                       | Badge                                 |
| ------------- | ------------------------------ | ------------------------------------- |
| `human`       | `canvas_edit`                  | The user's GitHub avatar and username |
| `human`       | `copilot_patch`                | Avatar with a copilot mark - accepted |
| `copilot`     | `copilot_patch`                | Model name from `author_agent`        |
| `system`      | `proposal` / `fork` / `import` | Plain label naming which              |

A human accepting a copilot suggestion is a distinct case from the copilot writing one, and the badge
says which, because "who changed this and did a person look at it" is the question a reader of the
history actually has.

```typescript
// apps/web/src/lib/api/experiments.ts -- the prediction payload this page renders
export interface RevisionPrediction {
  revisionId: string;
  modelVersion: string;
  cost: Prediction<ArchitectureCost>;
  availability: Prediction<AvailabilityReport>;
  latency: Prediction<PathLatency>;
  slos: Prediction<SloProposal[]>;
  findings: RuleFinding[];
}

/** 200 with the payload, or 501 while the prediction plane is unbuilt. */
export function getPrediction(
  experimentId: string,
  revisionId: string
): Promise<RevisionPrediction | null>;
```

`GET /experiments/:id/revisions/:revisionId/prediction` is the prediction plane's HTTP surface and is
owned by #8, not by this issue. No issue currently creates it, which is stated here rather than
worked around: this page ships the panel, the typed client, and an explicit "not modelled yet" state,
and renders real figures the day that route answers. Computing cost or availability in `apps/web` to
fill the gap is forbidden below, because a second implementation of a model is a second set of
numbers.

```typescript
// apps/web/src/components/experiment/DeploymentStatusCard.tsx
export interface DeploymentStatusCardProps {
  experiment: Experiment;
  /** Null when nothing has ever been deployed from this experiment. */
  deployment: Deployment | null;
  /** Null when no load test has produced a joined SLI. */
  sli: MeasuredSli | null;
}
```

Four states, and the fourth is the one that matters: never deployed; deploying, with a link to the
existing SSE stream at `GET /experiments/:id/events` (#29) rather than a second polling loop;
deployed with a measured SLI; and deployed with no load test, which reads "deployed, not measured"
and offers the load test rather than showing the prediction as though it had been confirmed.

The verdict panel writes through `PATCH /experiments/:id` and requires a note, mirroring the database
CHECK. It states which revision the verdict was recorded against, since a verdict on `seq` 3 says
nothing about `seq` 9.

### Files

- CREATE `apps/web/src/pages/ExperimentPage.tsx`
- CREATE `apps/web/src/lib/stores/experiment-store.ts`
- CREATE `apps/web/src/lib/stores/experiment-store.test.ts`
- CREATE `apps/web/src/components/experiment/RevisionTimeline.tsx`
- CREATE `apps/web/src/components/experiment/RevisionAuthorBadge.tsx`
- CREATE `apps/web/src/components/experiment/HistoryModeBanner.tsx`
- CREATE `apps/web/src/components/experiment/PredictionSummary.tsx`
- CREATE `apps/web/src/components/experiment/DeploymentStatusCard.tsx`
- CREATE `apps/web/src/components/experiment/VerdictPanel.tsx`
- CREATE `apps/web/src/components/experiment/CommitRevisionDialog.tsx`
- CREATE `apps/web/src/components/experiment/index.ts`
- CREATE `apps/web/src/components/experiment/RevisionTimeline.test.tsx`
- CREATE `apps/web/src/components/experiment/PredictionSummary.test.tsx`
- CREATE `apps/web/src/components/experiment/DeploymentStatusCard.test.tsx`
- MODIFY `apps/web/src/lib/stores/designer-store.ts` - reduce to view preferences, bump the persist key
- MODIFY `apps/web/src/lib/api/experiments.ts` - revision reads, commit, prediction client
- MODIFY `apps/web/src/lib/hooks/use-experiments.ts` - the hooks above
- MODIFY `apps/web/src/components/designer/DesignerCanvas.tsx` - read the experiment store, accept `readOnly`
- MODIFY `apps/web/src/components/designer/DesignerToolbar.tsx` - commit and branch replace save
- MODIFY `apps/web/src/components/designer/PropertiesPanel.tsx` - inputs disabled in history mode
- MODIFY `apps/web/src/components/designer/ServicePalette.tsx` - hidden in history mode
- MODIFY `apps/web/src/App.tsx` - point `/experiments/:id` at `ExperimentPage`

### Acceptance Criteria

- [ ] Opening `/experiments/:id` renders the head revision, and the timeline marks it as head
- [ ] Navigating from one experiment to another replaces the canvas completely, leaving no node from the first
- [ ] A page refresh restores the canvas from the server, and no canvas is read from `localStorage`
- [ ] `localStorage` after a session holds only panel state, active tab, and Pulumi language
- [ ] Selecting a revision that is not the head enters history mode and shows a banner naming the revision
- [ ] In history mode every store mutation is a no-op: dragging, deleting with the keyboard, connecting, and editing a property all leave the graph unchanged
- [ ] In history mode the palette is hidden and every property input is disabled
- [ ] `Branch from this revision` forks the experiment at that revision and navigates to the new one
- [ ] `Return to head` restores edit mode and asks before discarding pending edits
- [ ] Committing a revision requires a summary and sends the parent the canvas was seeded from
- [ ] A 409 from the commit shows what the head moved to and offers reloading it, rather than retrying or overwriting
- [ ] Each timeline entry distinguishes a human edit, a copilot edit, a human-accepted copilot edit, and a system revision
- [ ] The prediction panel shows every figure with its `Predicted` label and lists the assumptions behind it
- [ ] An unpriced resource is named with its reason and contributes nothing, rather than being shown as zero
- [ ] With no prediction available the panel says so and shows no numbers
- [ ] A deployed experiment with no load test reads as deployed and not measured, and does not present the prediction as confirmed
- [ ] A `partial` measured SLI is labelled partial wherever it appears
- [ ] The verdict cannot be recorded without a note, and the panel names the revision it applies to

### Required Tests

- `seeds the canvas from the head revision on open`
- `clears the previous experiment when a second one is opened`
- `ignores node changes while a historical revision is selected`
- `ignores a property edit while a historical revision is selected`
- `enters history mode for a non head revision and edit mode for the head`
- `branches from the selected revision rather than the head`
- `asks before discarding pending edits on return to head`
- `sends the seeded revision as the parent when committing`
- `surfaces a revision conflict with the new head instead of retrying`
- `labels a copilot revision with its model and a human revision with its user`
- `distinguishes an accepted copilot patch from a copilot authored one`
- `renders every predicted figure with its label and assumptions`
- `names an unpriced resource rather than showing zero`
- `reads deployed with no load test as not measured`
- `marks a partial sli as partial`
- `persists only view preferences to local storage`

### Performance Budget

Selecting a revision renders in under 150ms for a 200-node architecture, of which the network read of
one revision is the only unavoidable cost; the timeline itself never fetches an IR document. Canvas
interaction stays at 60fps for a 500-node graph, the budget `040-service-catalog-and-containment.md`
already sets. The workspace route is lazily loaded and must not move React Flow or the code
generators into the initial chunk.

### Out of Scope

- Do not compute cost, latency, availability, SLOs or Well-Architected findings in `apps/web`. The
  models are #8 and a second implementation is a second answer
- Do not build `GET /experiments/:id/revisions/:revisionId/prediction`. It is the prediction plane's
  HTTP surface and belongs to #8; this issue ships the client and the unmodelled state
- Do not build the side-by-side comparison; that is `docs/issues/epic-11-web/080-experiment-comparison.md`
- Do not add the copilot, a chat panel, or any streaming edit path. Epic 13 (#117) writes revisions
  through the same endpoint this page uses, which is the whole integration
- Do not implement deploy, destroy or load-test triggering beyond rendering their state and linking to
  the existing SSE stream; #111, #112 and #70 own those actions
- Do not change the IR to canvas conversion in `packages/core`; consume `irToCanvas` and `canvasToIr`
  from #79 as they are
- Do not delete `apps/web/src/pages/DesignerPage.tsx`; `060-experiments-list-and-entry-point.md`
  removes it along with its route

### Dependencies

Blocked by `docs/issues/epic-11-web/050-experiment-rest-api.md` for every endpoint, by #79 for the
canvas and IR conversion, and by #8 for real prediction figures. The deployment and measurement
states render data produced by #10 and #11 and show their absent states until those land.

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/web test
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
pnpm dev   # open two experiments in turn, select an old revision, branch from it, commit from two tabs
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines. The store reshape and the page are one change: the canvas components read
the store directly, so leaving them pointed at the global store for one merge would mean an
experiment page that silently shares one canvas between every experiment.
