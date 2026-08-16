---
title: '[ci] Measure diff coverage and report it, still without failing on it'
labels: tier:3, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

`170-coverage-reports-are-produced-and-kept.md` makes three coverage reports exist and survive their
jobs. This issue makes the `coverage` job read them, and print the number nobody in this repository
has ever seen.

It deliberately stops short of failing. The reason is arithmetic rather than caution: nobody knows
what the current diff coverage is. `.github/rulesets/main.json` requires the `Diff coverage` context,
so the first run that enforces a threshold decides, for every open pull request simultaneously,
whether it can merge. Choosing that threshold before measuring it is guessing, and guessing high
blocks the repository while guessing low sets a bar that never rises.

So this issue runs `diff-cover` with `--fail-under=0`, which computes and prints the real figure and
always exits zero, and posts it into the job summary so a reviewer can see the number on the pull
request rather than digging through logs. After a week of pull requests there is a distribution to
pick a starting ratchet from, which is what `190-coverage-is-enforced-at-a-ratchet.md` does.

The job also replaces its own guard. The `ls coverage.xml **/coverage*.xml` test never matched
anything — `**` without `globstar` is a single level, and the reports are two down — and once the
artifacts are downloaded the guard should ask the question that actually matters: did any report
arrive? A missing report after `170` has landed is a regression in the test jobs, not an inert gate,
and it should say so in the summary rather than passing silently.

One more thing this issue must get right. `diff-cover` takes multiple reports as positional arguments
and unions them, but only if their path roots agree. The Node reports are written under
`apps/*/coverage/`, the Python report under `services/brain/`, and the Rust report at the root; each
records paths relative to a different base. They are rebased onto the repository root before merging,
or a file covered by the API suite is reported as uncovered because `diff-cover` looked for
`apps/api/src/...` and the report said `src/...`.

Spec: `docs/DELIVERY.md`

### Contract

```yaml
# .github/workflows/gate-test.yml, the coverage job
- uses: actions/download-artifact@<pinned sha>
  with:
    pattern: coverage-*
    path: coverage-reports
    merge-multiple: false

- name: Report diff coverage
  run: |
    set -euo pipefail
    mapfile -t reports < <(find coverage-reports -name '*.xml' -print)
    if [ "${#reports[@]}" -eq 0 ]; then
      echo "::error::No coverage reports were uploaded; the test jobs stopped producing them."
      exit 1
    fi
    pipx install diff-cover
    diff-cover "${reports[@]}" \
      --compare-branch="origin/${{ github.base_ref || 'main' }}" \
      --fail-under=0 \
      --markdown-report coverage.md
    cat coverage.md >> "$GITHUB_STEP_SUMMARY"
```

`scripts/ci/rebase-coverage.mjs` rewrites each report's `filename` and `<source>` entries so every
path is relative to the repository root:

```javascript
/** Rewrite one Cobertura report in place so its paths are repository-relative. */
export function rebase(xml: string, packageRoot: string): string;
```

### Files

- `.github/workflows/gate-test.yml` — MODIFY: download the artifacts, replace the never-matching
  guard with one that fails when no report arrives, run `diff-cover` at `--fail-under=0`, write the
  markdown report into the job summary.
- `scripts/ci/rebase-coverage.mjs` — CREATE: rebase Cobertura paths onto the repository root.
- `scripts/ci/rebase-coverage.test.mjs` — CREATE: the cases below.

### Acceptance Criteria

- [ ] The `coverage` job downloads every artifact uploaded by the test jobs.
- [ ] The measured diff-coverage percentage appears in the job summary on every pull request.
- [ ] The job fails when no coverage report is uploaded at all.
- [ ] The job passes regardless of how low the measured coverage is.
- [ ] A line covered only by the API suite is credited, proving the reports were rebased and unioned rather than read in isolation.

### Required Tests

- `rebases a report written from a package directory` — a Cobertura report whose `filename` is
  `src/lib/env.ts` under package root `apps/api` becomes `apps/api/src/lib/env.ts`.
- `leaves an already-rooted report alone` — a report whose paths are already repository-relative is
  unchanged, so running the rebase twice is safe.
- `rewrites every source element` — a report carrying several `<source>` entries has all of them
  rebased, not only the first.
- `fails loudly on a report it cannot parse` — malformed XML raises rather than silently emitting an
  empty report, because an empty report reads as "nothing changed" and passes.

### Performance Budget

The `coverage` job must complete in under two minutes, dominated by `pipx install diff-cover`. It runs
in parallel with nothing, so this is wall clock on the critical path of every pull request.

### Out of Scope

- Any failing threshold. `--fail-under=0` is the point of this issue.
- Adding `Diff coverage` to the ruleset. It is already a required context.
- Raising coverage in any package. Measuring precedes improving.
- Per-package thresholds.

### Dependencies

Blocked by `docs/issues/epic-0-delivery/170-coverage-reports-are-produced-and-kept.md` (Epic #1),
which produces the artifacts this job downloads. Until it lands there is nothing to read and this
job's guard would fail by design.

### Verification

```bash
node --test scripts/ci/rebase-coverage.test.mjs
```

On the pull request, the job summary must carry a diff-coverage table with a real percentage, and the
check must be green. Then confirm the guard is live rather than decorative by deleting an upload step
in a scratch branch and watching the job fail with the "stopped producing them" message.
