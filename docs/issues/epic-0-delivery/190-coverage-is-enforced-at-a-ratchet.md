---
title: '[ci] Enforce diff coverage at a measured ratchet, rising toward 85%'
labels: tier:3, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

With `170` producing reports and `180` measuring them, `Diff coverage` finally has a number. This
issue makes it a verdict.

`docs/DELIVERY.md` states the target: 85% of changed lines, with the reasoning that _"A global
coverage threshold is trivially gamed by adding tests to untouched code. Diff coverage holds each PR
to its own standard."_ That reasoning is right and the target stands. What must not happen is going
from no enforcement to 85% in one step, because `.github/rulesets/main.json` lists `Diff coverage`
among its 25 required contexts and every open pull request would fail the moment this merged.

So the threshold starts at the figure `180` has been printing — rounded **down** to the nearest five,
so the first enforcing run cannot fail on noise — and rises. The mechanism is the one already used
for the web bundle in `docs/DELIVERY.md`: a ratchet, held in a file, raised in its own pull request
with the measurement in the body.

The ratchet lives in `perf-budgets.json` rather than inline in the workflow, because the bundle
budget's history is the argument against inlining it: `docs/DELIVERY.md` says 250 KB target and 260 KB
ratchet, `gate-perf.yml` passes 215, and issue #175 measures something else again. Three numbers, one
budget, no single place to change it. Coverage should not repeat that.

A ratchet that only ever rises needs one escape hatch, and it needs to be visible. A pull request that
legitimately lowers diff coverage — deleting a well-tested module and replacing it with a thinner one
is the usual case — carries the `coverage-ratchet-lowered` label, and the job accepts the drop while
recording it in the summary. Nothing silently lowers the bar.

Spec: `docs/DELIVERY.md`

### Contract

```jsonc
// perf-budgets.json, at the repository root
{
  "webInitialJsGzipKb": 215,
  "diffCoveragePercent": 0, // replaced by the measured figure when this lands
}
```

```yaml
# .github/workflows/gate-test.yml, the coverage job
- name: Enforce diff coverage
  run: |
    set -euo pipefail
    threshold="$(node -p "require('./perf-budgets.json').diffCoveragePercent")"
    if [ "${{ contains(github.event.pull_request.labels.*.name, 'coverage-ratchet-lowered') }}" = "true" ]; then
      echo "::notice::Ratchet waived by label; measuring without enforcing."
      threshold=0
    fi
    diff-cover "${reports[@]}" \
      --compare-branch="origin/${{ github.base_ref || 'main' }}" \
      --fail-under="$threshold" \
      --markdown-report coverage.md
    cat coverage.md >> "$GITHUB_STEP_SUMMARY"
```

`.github/labels.yml` gains:

```yaml
- name: 'coverage-ratchet-lowered'
  color: 'fbca04'
  description: 'This pull request lowers diff coverage on purpose; the reason is in the body.'
```

### Files

- `perf-budgets.json` — CREATE: the single home for both the coverage ratchet and the web bundle
  budget.
- `.github/workflows/gate-test.yml` — MODIFY: read the threshold from `perf-budgets.json`, honour the
  waiver label, fail below it.
- `.github/workflows/gate-perf.yml` — MODIFY: read `webInitialJsGzipKb` from the same file instead of
  the hard-coded `215`.
- `scripts/ci/check-bundle-size.mjs` — MODIFY: default its budget from `perf-budgets.json` when no
  argument is given, so the two callers cannot disagree.
- `.github/labels.yml` — MODIFY: add the waiver label.
- `docs/DELIVERY.md` — MODIFY: cite `perf-budgets.json` for both numbers rather than restating them.

### Acceptance Criteria

- [ ] A pull request whose changed lines fall below the ratchet fails `Diff coverage`.
- [ ] A pull request at or above the ratchet passes.
- [ ] The threshold is read from `perf-budgets.json` and appears in the job summary alongside the measured figure.
- [ ] A pull request carrying `coverage-ratchet-lowered` passes and records the waiver in the summary.
- [ ] `docs/DELIVERY.md` no longer states a bundle number that disagrees with the one the gate uses.
- [ ] The initial ratchet is the measured figure rounded down to the nearest five, and the pull request body carries the measurement it came from.

### Required Tests

- `reads the bundle budget from perf-budgets.json when no argument is given` — `check-bundle-size.mjs`
  invoked without a budget argument uses the file, so the workflow and a local run agree.
- `an explicit argument still wins` — the existing call form keeps working, so this is not a breaking
  change to the script's interface.
- `fails when the budget file is missing or malformed` — an unreadable `perf-budgets.json` is an error
  rather than a silent fallback to a default that nobody chose.
- A deliberately untested change on a scratch branch must fail `Diff coverage`, which is the assertion
  that the gate is finally live. A well-tested change on the same branch must pass.

### Performance Budget

No change to the coverage job's two-minute ceiling; reading a JSON file is free.

### Out of Scope

- Raising the ratchet to 85 in this issue. It rises in later pull requests, each carrying its
  measurement.
- Backfilling tests anywhere to lift the starting figure.
- Adding `Diff coverage` to the ruleset; it is already required.
- The WASM budget line, which belongs to `200-one-home-for-the-size-budgets.md`.

### Dependencies

Blocked by `docs/issues/epic-0-delivery/180-coverage-is-measured-and-reported.md` (Epic #1), whose
printed figure is the only defensible source for the starting ratchet.

### Verification

```bash
node scripts/ci/check-bundle-size.mjs apps/web/dist
node --test scripts/ci/check-bundle-size.test.mjs
```

Then prove the gate is live on a scratch branch, which is the whole point of the three-issue sequence:

```bash
git switch -c scratch/prove-coverage-gate
printf 'export function untested(a: number) { return a * 2; }\n' >> packages/core/src/types.ts
git commit -am 'test: prove the coverage gate refuses an untested line'
```

The pull request for that branch must fail `Diff coverage`, and must pass once a test is added.
