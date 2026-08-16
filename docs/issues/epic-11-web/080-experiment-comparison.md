---
title: '[web] Compare two experiments without printing a prediction next to a measurement'
labels: tier:2, size:l, area:web, epic:11-ui
---

### Epic

#12

### Context

This is the screen the product exists to show. Everything before it -- analysis, the IR, the canvas,
the cost model, the deployment, the load test -- produces one experiment; the reason to produce two
is to find out which architecture is better for a particular application, and that answer is only
visible when the two are on one page.

The comparison is easy to build dishonestly, and the dishonest version is the one that falls out of a
naive table. Put whatever number is available in each cell and experiment A, which has been deployed
and load tested at a measured p99 of 180ms, sits next to experiment B, which has a modelled p99 of
120ms, under a heading that says p99. A reader concludes B is faster. What has actually been compared
is a machine against an arithmetic model with a stated error bar, and the asymmetry is not the
exception: it is the normal case, because deploying and load testing costs money and time and a user
does it for the option they are seriously considering, not for both.

Two fixes were considered and rejected. Hiding the measurement unless both sides have one throws away
the only ground truth on the page, and it means the more work a user does the less the comparison
tells them. Comparing measured against predicted with a footnote was rejected because the winner
badge is what people read; a caveat under a table does not survive a screenshot pasted into a
decision document.

**So the two sides are always compared on the predicted basis, and a measurement is shown as evidence
about the model rather than as a competitor.** Both architectures can be modelled, always, because
both are IR documents -- that is what makes the predicted basis the only one that is symmetric. Where
a side has been deployed and measured, its measured figure is shown beneath its predicted figure with
the signed relative error between them, which is exactly the `MetricComparison` that #72 already
computes and stores. The headline therefore says "B is predicted 33% cheaper" and, separately, "the
cost model was 12% low on A where we checked it", which are two true statements. A delta is computed
if and only if both cells hold values on the same basis, and the type below makes it impossible to
render one otherwise.

A `partial` measurement never produces a delta or an error figure either. `030-metrics-join.md`
already defines `partial` as an SLI computed over a series that never settled, and treating it as
measured is the same mistake one layer down.

The structural diff has its own trap. Two experiments forked from one another share node ids, so
matching on id is exact; two experiments created independently from the same repository share nothing
but the proposal's naming, so matching on id alone reports every node as both added and removed and
the diff is noise. Matching is therefore id first, then `(kind, name)` among what is left, then
`(kind)` where exactly one unmatched node of that kind remains on each side, and anything still
unmatched is a genuine addition or removal. Fuzzy matching beyond that was rejected: a wrong pairing
reports a parameter change that never happened, which is worse than an honest add-and-remove.

Spec: `docs/issues/epic-11-web/070-experiment-workspace-page.md`

### Contract

The route is `/experiments/compare?a=<experimentId>&b=<experimentId>`, with optional `ra` and `rb`
naming a revision on each side; both default to the head. Revisions are addressable so a user can
compare what they have now against what they had three revisions ago on the other experiment.

```typescript
// packages/core/src/ir/diff.ts
import type { ArchitectureIr, IrNode, ResourceKind } from '@infracanvas/ir-schema';

export interface ParamChange {
  /** JSON Pointer into the node, e.g. `/params/instanceClass`. */
  pointer: string;
  before: unknown;
  after: unknown;
}

export interface NodeSummary {
  id: string;
  kind: ResourceKind;
  name: string;
  /** Ancestor names, outermost first, so a reader can see which subnet it sat in. */
  path: string[];
}

export type MatchBasis = 'id' | 'kind-and-name' | 'sole-kind';

export interface ChangedNode {
  a: NodeSummary;
  b: NodeSummary;
  /** How the two nodes were paired, so a surprising diff can be explained. */
  matchedBy: MatchBasis;
  params: ParamChange[];
}

export interface IrStructuralDiff {
  addedNodes: NodeSummary[];
  removedNodes: NodeSummary[];
  changedNodes: ChangedNode[];
  addedEdges: { id: string; source: string; target: string; kind: string }[];
  removedEdges: { id: string; source: string; target: string; kind: string }[];
  /** Per kind counts on each side, for the one-line headline above the detail. */
  kindDelta: { kind: ResourceKind; a: number; b: number }[];
}

/** Pure and deterministic. Never throws for two valid documents. */
export function diffIr(a: ArchitectureIr, b: ArchitectureIr): IrStructuralDiff;
```

The comparison model is computed in `packages/core` rather than assembled in a component, so the rule
that governs the whole page is a function with tests rather than a convention in JSX:

```typescript
// packages/core/src/prediction/comparison.ts
export type MetricId =
  | 'monthly_usd'
  | 'availability'
  | 'downtime_minutes'
  | 'p50_ms'
  | 'p99_ms'
  | 'sustainable_rps'
  | 'slo_availability';

export type Basis = 'predicted' | 'measured';

export type ComparisonCell =
  | {
      state: 'value';
      basis: Basis;
      value: number;
      unit: string;
      /** The literal from #101 and #71. A renderer cannot print a figure unlabelled. */
      label: 'Predicted' | 'Measured';
      /** Only for a measured cell. `partial` never participates in a delta. */
      confidence?: 'measured' | 'partial';
    }
  | { state: 'unmodelled'; reason: string }
  | { state: 'unmeasured'; reason: string };

export interface MetricDelta {
  absolute: number;
  relative: number;
  /** `neither` when the difference is inside the noise floor for that metric. */
  better: 'a' | 'b' | 'neither';
}

export interface ComparisonRow {
  metric: MetricId;
  label: string;
  /** Lower is better for cost, latency and downtime; higher for availability and RPS. */
  direction: 'lower-is-better' | 'higher-is-better';
  a: ComparisonCell;
  b: ComparisonCell;
  /** Set only when both cells are values on the same basis. */
  delta: MetricDelta | null;
  /** Set instead of a delta when the two cells cannot honestly be subtracted. */
  incomparable: 'basis_mismatch' | 'partial_measurement' | 'missing_side' | null;
  /**
   * Where a side has been measured, the signed error of the model on that side.
   * Evidence about the prediction, not a term in the comparison.
   */
  modelError: { side: 'a' | 'b'; relativeError: number }[];
}

export interface FindingsByPillar {
  pillar: Pillar;
  a: { high: number; medium: number; low: number };
  b: { high: number; medium: number; low: number };
  /** Findings raised on exactly one side, which is what a reader is looking for. */
  onlyA: RuleFinding[];
  onlyB: RuleFinding[];
  shared: RuleFinding[];
}

export interface ExperimentComparison {
  a: ComparisonSide;
  b: ComparisonSide;
  rows: ComparisonRow[];
  findings: FindingsByPillar[];
  structure: IrStructuralDiff;
  /** One sentence on the predicted basis, plus the model-error caveat where one exists. */
  headline: { verdict: string; caveat: string | null };
}

export interface ComparisonSide {
  experimentId: string;
  revisionId: string;
  name: string;
  hypothesis: string;
  repository: { githubOwner: string; githubName: string } | null;
  deployed: boolean;
  measuredAt: string | null;
}

export function buildComparison(input: BuildComparisonInput): ExperimentComparison;
```

The rule, stated once and asserted by tests rather than left to each renderer:

```
delta is non-null   <=>  a.state === 'value' && b.state === 'value'
                         && a.basis === b.basis
                         && a.confidence !== 'partial' && b.confidence !== 'partial'

basis_mismatch      when both are values and the bases differ
partial_measurement when either measured cell is partial
missing_side        when either cell is unmodelled or unmeasured
```

Because every architecture can be modelled, the predicted rows are symmetric in practice, and
`basis_mismatch` should be unreachable through the page's own data assembly. It exists anyway, and is
tested, because the type is what stops a later contributor filling a predicted column with the one
measurement they happen to have.

What each side of a row renders:

| Situation                                  | Rendering                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Both predicted                             | Both figures, the delta, and a winner mark on the better side                   |
| Both predicted, one also measured          | As above, plus the measured figure beneath that side and its signed model error |
| Both predicted, both measured              | As above on both sides; the delta is still on the predicted basis               |
| One side unmodelled                        | The reason on that side, no delta, no winner                                    |
| A measured value with `partial` confidence | Shown, labelled partial, excluded from the model error                          |
| Neither deployed                           | No measured region at all, and a note that nothing has been measured yet        |

The asymmetry is also stated in prose above the table, once, in the form the user needs: which side
has been deployed and measured, which has not, and that the ranking below is computed from the models
for both. Where exactly one side is measured the page offers `Deploy and load test <other side>` as
the action that removes the asymmetry, since the point of naming it is to make it fixable.

Well-Architected findings come from #80 as `RuleFinding[]` and are grouped by `Pillar`. The default
view is `onlyA` and `onlyB`, because a finding both architectures raise is a property of the
application rather than a reason to choose between them; `shared` is collapsed behind a count.

### Files

- CREATE `packages/core/src/ir/diff.ts`
- CREATE `packages/core/src/ir/diff.test.ts`
- CREATE `packages/core/src/prediction/comparison.ts`
- CREATE `packages/core/src/prediction/comparison.test.ts`
- CREATE `apps/web/src/pages/ComparisonPage.tsx`
- CREATE `apps/web/src/components/comparison/ComparisonHeader.tsx`
- CREATE `apps/web/src/components/comparison/MetricTable.tsx`
- CREATE `apps/web/src/components/comparison/MetricCell.tsx`
- CREATE `apps/web/src/components/comparison/MeasurementBanner.tsx`
- CREATE `apps/web/src/components/comparison/FindingsByPillar.tsx`
- CREATE `apps/web/src/components/comparison/StructuralDiff.tsx`
- CREATE `apps/web/src/components/comparison/index.ts`
- CREATE `apps/web/src/components/comparison/MetricCell.test.tsx`
- CREATE `apps/web/src/components/comparison/MetricTable.test.tsx`
- CREATE `apps/web/src/components/comparison/StructuralDiff.test.tsx`
- CREATE `apps/web/src/lib/hooks/use-comparison.ts` - loads both sides in parallel
- MODIFY `packages/core/src/index.ts` - export `diffIr` and the comparison model
- MODIFY `apps/web/src/lib/api/experiments.ts` - fetch a named revision and its prediction per side
- MODIFY `apps/web/src/App.tsx` - point `/experiments/compare` at `ComparisonPage`

### Acceptance Criteria

- [ ] A delta is produced only when both cells hold values on the same basis, asserted by the model rather than by the component
- [ ] A predicted cell against a measured cell produces `incomparable: 'basis_mismatch'`, no delta and no winner mark
- [ ] A measured cell with `partial` confidence produces `incomparable: 'partial_measurement'` and no delta
- [ ] Where one side is deployed and measured and the other is not, the ranking is computed from both predictions and the measurement is shown as model error on its own side
- [ ] The page states in prose which side has been measured and which has not, before the table
- [ ] Where exactly one side is measured the page offers deploying and load testing the other
- [ ] With neither side deployed, no measured region is rendered and the absence is stated
- [ ] Every rendered figure carries its `Predicted` or `Measured` label
- [ ] An unmodelled metric shows its reason and never renders as zero or a dash
- [ ] `diffIr` pairs nodes by id when the two documents share ids, and reports `matchedBy: 'id'`
- [ ] `diffIr` pairs by kind and name when ids differ, and reports `matchedBy: 'kind-and-name'`
- [ ] `diffIr` leaves a node unmatched rather than pairing two nodes of the same kind when more than one candidate remains on either side
- [ ] `diffIr` is deterministic: the same pair of documents yields byte-identical output, and `diffIr(a, b)` is the exact inverse of `diffIr(b, a)` for added and removed
- [ ] Findings are grouped by pillar with counts by severity, and findings raised on one side only are shown first
- [ ] Comparing an experiment the caller does not own returns the not-found state rather than a partly rendered page
- [ ] Comparing an experiment with itself is refused with a readable message rather than rendering an all-zero diff

### Required Tests

- `computes a delta only when both sides share a basis`
- `refuses to subtract a measurement from a prediction`
- `excludes a partial measurement from the delta and from the model error`
- `ranks on the predicted basis when only one side has been measured`
- `reports the signed model error on the measured side`
- `states that nothing has been measured when neither side is deployed`
- `labels every figure as predicted or measured`
- `shows an unmodelled metric as unmodelled rather than zero`
- `matches nodes by id across two forked experiments`
- `matches nodes by kind and name across two independent experiments`
- `leaves ambiguous nodes unmatched rather than guessing a pair`
- `produces identical output for the same pair of documents twice`
- `mirrors added and removed when the two sides are swapped`
- `groups findings by pillar and lists one sided findings first`
- `refuses to compare an experiment with itself`

### Performance Budget

`diffIr` over two 500-node documents completes in under 30ms, measured with `performance.now()` in
`diff.test.ts`, using an index over node ids and over `(kind, name)` rather than a nested scan.
`buildComparison` completes in under 10ms given both sides' predictions. The page issues at most four
network requests -- one revision and one prediction per side -- and loads them in parallel, so the
comparison is visible in one round trip's time rather than four.

### Out of Scope

- Do not compute cost, latency, availability or Well-Architected findings here. Both sides' figures
  come from #8 and #80 through the prediction endpoint the workspace issue defines
- Do not compute the model error from raw run data; `CalibrationReport` from #72 already states it,
  and a second calculation would eventually disagree with the stored one
- Do not compare more than two experiments. A third column is a different layout, a different diff,
  and a different set of tests
- Do not render the two architectures as canvases side by side; the structural diff is the comparison,
  and two React Flow instances on one page is a separate performance problem
- Do not add export to PDF, sharing links, or an embed. The decision document is out of scope
- Do not change `packages/core/src/ir/canvas.ts` or the IR schema to make diffing easier
- Do not write a verdict automatically from the comparison. The verdict is the user's, recorded in
  `docs/issues/epic-11-web/070-experiment-workspace-page.md`

### Dependencies

Blocked by `docs/issues/epic-11-web/070-experiment-workspace-page.md` for the revision and prediction
clients, by #77 and #79 for the IR types the diff walks, by #8 for the predicted figures, by #80 for
the Well-Architected findings, and by #71 and #72 for the measured SLI and the recorded model error.
Until #8 answers, every metric row renders as unmodelled and the structural diff is the whole page,
which is a useful screen on its own and is why this issue is not blocked on the models landing first.

### Verification

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @infracanvas/core test
pnpm --filter @infracanvas/web test
pnpm --filter @infracanvas/web build && node scripts/ci/check-bundle-size.mjs apps/web/dist 215
pnpm dev   # compare a fork against its source, then two independently created experiments
```

### Risk Tier

tier:2 - normal application code

### Size

size:l - over 600 lines. The diff and the comparison model could land separately, but the honesty
rule is enforced by the shape of `ComparisonRow`, and shipping the page against a looser intermediate
type is how the naive table gets built by accident.
