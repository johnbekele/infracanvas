---
title: '[web] Land on your experiments and start one from a connected repository'
labels: tier:2, size:m, area:web, epic:11-ui
---

### Epic

#12

### Context

The application has no home. `apps/web/src/App.tsx` routes `/` to `LandingPage`, `/repositories` to a
list, `/repositories/:id` to an analysis with an architecture proposal rendered from a `useMemo`, and
`/designer` to a blank canvas backed by a single global Zustand store. None of those is a place a
returning user can go to find what they were doing. `RepositoryPage` computes a proposal, draws it,
and offers no action that turns it into anything; `DesignerPage` opens a canvas attached to no
repository at all. The product is a wizard you walk through and then leave.

With experiments as a durable object, the entry point changes shape. The first question is no longer
"which repository" but "which of my experiments", and a repository becomes the thing you start an
experiment from rather than the thing you navigate. So `/experiments` becomes the landing route for a
signed-in user, and the repository pages stay exactly as they are, reached from the create flow and
from a link in the header.

`/designer` is retired rather than kept alongside. A canvas not attached to an experiment cannot be
priced, deployed, load tested or compared, and every one of those is what the canvas is for. Keeping
it also means keeping the persisted global `designer-store`, which
`docs/issues/epic-11-web/070-experiment-workspace-page.md` removes; two canvases with different
storage rules is how a user ends up looking at a stale architecture and believing the cost printed
next to it. The route redirects to `/experiments` so an old bookmark lands somewhere sensible.

**The empty state is the product.** A new user has no experiments, so the first screen they see is
whichever empty state applies, and a single "No experiments yet" panel would be wrong for all three
reasons a user can have none. Not signed in, signed in with no connected repository, and connected
with nothing analysed are three different dead ends with three different next actions, and offering
"Create experiment" to someone who has connected nothing produces a dialog with an empty picker.
Each case therefore states the reason and offers exactly the one action that resolves it, reusing
`AuthMethodPicker` and `ConnectRepositoryDialog` rather than growing a second sign-in or connect
flow.

Spec: `docs/issues/epic-11-web/050-experiment-rest-api.md`

### Contract

Routes, after this issue:

| Path                   | Element                                  | Note                                                  |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `/`                    | `LandingPage`                            | Redirects to `/experiments` when authenticated        |
| `/experiments`         | `ExperimentsPage`                        | The home of the product                               |
| `/experiments/:id`     | `ExperimentPage`                         | Lazy; delivered by `070-experiment-workspace-page.md` |
| `/experiments/compare` | `ComparisonPage`                         | Lazy; delivered by `080-experiment-comparison.md`     |
| `/repositories`        | `RepositoriesPage`                       | Unchanged, reached from the header                    |
| `/repositories/:id`    | `RepositoryPage`                         | Unchanged                                             |
| `/designer`            | `<Navigate to="/experiments" replace />` | `DesignerPage.tsx` is deleted                         |

```typescript
// apps/web/src/lib/api/experiments.ts -- added alongside the workspace client
export interface ExperimentListItem {
  id: string;
  name: string;
  hypothesis: string;
  status: ExperimentStatus;
  verdict: 'undecided' | 'adopt' | 'reject' | 'inconclusive';
  revisionCount: number;
  head: RevisionSummary | null;
  repository: { id: string; githubOwner: string; githubName: string } | null;
  forkedFromExperimentId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export declare const experimentsApi: {
  list(): Promise<ExperimentListItem[]>;
  create(
    body: CreateExperimentBody
  ): Promise<{ experiment: ExperimentListItem; revisionId: string }>;
  fork(id: string, body?: ForkExperimentBody): Promise<{ experiment: ExperimentListItem }>;
  rename(id: string, fields: { name?: string; hypothesis?: string }): Promise<ExperimentListItem>;
  remove(id: string): Promise<void>;
};
```

```typescript
// apps/web/src/lib/hooks/use-experiments.ts
const keys = {
  all: ['experiments'] as const,
  detail: (id: string) => ['experiments', id] as const,
  revisions: (id: string) => ['experiments', id, 'revisions'] as const,
};

export function useExperiments(): UseQueryResult<ExperimentListItem[]>;

export function useCreateExperiment(): UseMutationResult<
  { experiment: ExperimentListItem; revisionId: string },
  ApiError,
  CreateExperimentBody
>;

export function useForkExperiment(): UseMutationResult<
  { experiment: ExperimentListItem },
  ApiError,
  { id: string; body?: ForkExperimentBody }
>;

export function useDeleteExperiment(): UseMutationResult<void, ApiError, string>;
```

The key factory mirrors `apps/web/src/lib/hooks/use-repositories.ts` so invalidation reads the same
way in both files.

```typescript
// apps/web/src/components/experiments/ExperimentsEmptyState.tsx
export type EmptyReason = 'signed-out' | 'no-repositories' | 'no-analysis' | 'no-experiments';

export interface ExperimentsEmptyStateProps {
  reason: EmptyReason;
  /** Only for `no-analysis`: the repositories that are connected but unanalysed. */
  unanalysed?: ConnectedRepository[];
  onConnect(): void;
  onCreate(): void;
}
```

`reason` is derived in one place and in this order, because each case is a precondition for the next:

```
not authenticated                              -> 'signed-out'
no connected repositories                      -> 'no-repositories'
no repository has a succeeded analysis         -> 'no-analysis'
otherwise                                      -> 'no-experiments'
```

What each empty state says and offers:

| Reason            | Headline                                | Action                                    |
| ----------------- | --------------------------------------- | ----------------------------------------- |
| `signed-out`      | Sign in to run your first experiment    | `AuthMethodPicker`, unchanged             |
| `no-repositories` | Connect the repository you want to test | Opens `ConnectRepositoryDialog`           |
| `no-analysis`     | Analyse a repository first              | Links to `/repositories/:id` for each one |
| `no-experiments`  | No experiments yet                      | Opens `CreateExperimentDialog`            |

Every one of them carries the same sentence explaining what an experiment is, because for a new user
this screen is the only explanation they get: an experiment is one repository, one hypothesis about
its AWS architecture, and the cost, latency and availability that follow from it -- and two
experiments over the same repository can be compared.

```typescript
// apps/web/src/components/experiments/CreateExperimentDialog.tsx
export interface CreateExperimentDialogProps {
  open: boolean;
  onClose(): void;
  /** Preselects and locks the repository when opened from a repository page. */
  repositoryId?: string;
}
```

The dialog collects a repository, a name, and a hypothesis. Hypothesis is required and the submit
button stays disabled without it, with the placeholder `Aurora Serverless v2 costs less than a
db.t4g.medium under bursty traffic`. It shows which analysis the architecture will be seeded from --
the ref and the short commit sha, exactly as `RepositoryPage` already prints them -- so the user
knows what the first revision describes. A repository with no succeeded analysis is listed as
disabled with "Not analysed yet" and a link, rather than hidden, because hiding it makes the user
think the repository is not connected.

```typescript
// apps/web/src/components/experiments/CompareSelectionBar.tsx
/**
 * Comparison takes exactly two experiments. The bar appears at one selection and
 * says what is missing rather than leaving a disabled button unexplained.
 */
export interface CompareSelectionBarProps {
  selected: ExperimentListItem[];
  onClear(): void;
}
```

Selecting a third experiment replaces the older of the two rather than refusing, so the interaction
never dead-ends. Comparing two experiments over different repositories is allowed but the bar warns
that the structural diff will be large, because the honest answer is that it is a legal thing to do
and rarely a useful one.

Each card shows: name, hypothesis, `owner/name` of the repository, revision count, status, verdict
chip, the age of the head revision, and a fork action. Predicted monthly cost is shown only where the
prediction plane (#8) has answered for the head revision, and is otherwise absent; a dash and a
tooltip were rejected because an empty currency column reads as free.

### Files

- CREATE `apps/web/src/pages/ExperimentsPage.tsx`
- CREATE `apps/web/src/components/experiments/ExperimentCard.tsx`
- CREATE `apps/web/src/components/experiments/ExperimentsEmptyState.tsx`
- CREATE `apps/web/src/components/experiments/CreateExperimentDialog.tsx`
- CREATE `apps/web/src/components/experiments/CompareSelectionBar.tsx`
- CREATE `apps/web/src/components/experiments/VerdictChip.tsx`
- CREATE `apps/web/src/components/experiments/index.ts`
- CREATE `apps/web/src/components/experiments/ExperimentsEmptyState.test.tsx`
- CREATE `apps/web/src/components/experiments/CreateExperimentDialog.test.tsx`
- CREATE `apps/web/src/components/experiments/CompareSelectionBar.test.tsx`
- MODIFY `apps/web/src/App.tsx` - the routes above, with `/experiments/:id` and `/experiments/compare` lazy
- MODIFY `apps/web/src/pages/LandingPage.tsx` - redirect an authenticated visitor to `/experiments`
- MODIFY `apps/web/src/components/layout/AppHeader.tsx` - Experiments first, Repositories second
- MODIFY `apps/web/src/pages/RepositoryPage.tsx` - a "Start an experiment" action beside the proposal
- DELETE `apps/web/src/pages/DesignerPage.tsx`

### Acceptance Criteria

- [ ] An authenticated visitor to `/` arrives at `/experiments` without a flash of the landing page
- [ ] An unauthenticated visitor to `/experiments` sees the sign-in empty state, not a redirect loop
- [ ] `/designer` redirects to `/experiments` and replaces the history entry rather than pushing one
- [ ] With no connected repositories the empty state offers the connect dialog and not the create dialog
- [ ] With repositories but no succeeded analysis the empty state lists those repositories with a link to each
- [ ] With an analysed repository and no experiments the empty state offers the create dialog
- [ ] The create dialog refuses to submit without a hypothesis, and the reason is visible before submit
- [ ] The create dialog names the ref and short commit sha of the analysis the first revision is seeded from
- [ ] A repository with no succeeded analysis appears disabled in the picker with a link, rather than absent
- [ ] Creating an experiment navigates to `/experiments/:id` and the list shows it on return
- [ ] Selecting two experiments enables Compare and navigates to `/experiments/compare?a=&b=`
- [ ] Selecting a third replaces the earlier selection rather than being ignored
- [ ] A card shows predicted monthly cost only when the prediction exists, and shows nothing where it does not
- [ ] Forking from a card creates a second experiment and the list shows both against the same repository
- [ ] Deleting an experiment that is deploying surfaces the API 409 as a readable message rather than a silent failure
- [ ] The initial JavaScript payload stays within the Gate 6 budget; the workspace and comparison pages load on demand

### Required Tests

- `sends an authenticated visitor from the landing route to experiments`
- `shows the sign-in empty state rather than redirecting an anonymous visitor`
- `offers connect rather than create when no repository is connected`
- `lists unanalysed repositories when none has a succeeded analysis`
- `disables submit until a hypothesis is entered`
- `names the analysis the first revision is seeded from`
- `shows an unanalysed repository as disabled with a link rather than hiding it`
- `enables compare at exactly two selections`
- `replaces the oldest selection when a third experiment is picked`
- `omits the cost figure when the head revision has no prediction`
- `surfaces a delete conflict from the api as a readable message`

### Performance Budget

`/experiments` renders from one `GET /experiments` request and no per-card follow-up, so a list of
200 experiments issues one network call. First contentful paint on the experiments route stays within
the Gate 6 bundle budget checked by `scripts/ci/check-bundle-size.mjs`; the canvas, React Flow and the
code generators must not enter the initial chunk, which is what deleting `DesignerPage` and lazily
loading `/experiments/:id` is for.

### Out of Scope

- Do not change the analysis flow, `proposeArchitecture`, or anything under
  `apps/web/src/components/analysis/`; the repository pages keep working as they do
- Do not build the workspace canvas or the revision timeline; that is
  `docs/issues/epic-11-web/070-experiment-workspace-page.md`
- Do not build the comparison view beyond navigating to its route
- Do not delete `apps/web/src/lib/stores/designer-store.ts` here. The workspace issue reshapes it,
  and removing it in the same change as the route rewrite makes both unreviewable
- Do not add search, filtering, tagging, or pagination. One user's experiment list is small, and a
  filter over an empty list is the wrong thing to build first
- Do not add deployment or load-test controls to a card; those live in the workspace

### Dependencies

Blocked by `docs/issues/epic-11-web/050-experiment-rest-api.md` for every endpoint this page calls.
The cost figure on a card is blocked by #8 and is absent until it lands.

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/web test
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
pnpm dev   # visit /, /designer, and /experiments signed in and signed out
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
