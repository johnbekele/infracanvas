---
title: '[ci] Repair the scheduled and performance gates before their components land'
labels: tier:1, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

Three jobs are wired to fail the moment the thing they measure starts existing. All three pass today
only because their guards short-circuit before reaching the broken step, so the failure will arrive
attached to whichever pull request first lands the component — and will be diagnosed as a problem with
that component rather than with the workflow.

**`nightly.yml`, the `rag-eval` job.** It runs `uv run --directory services/brain python -m
brain.eval.harness ...` with no `astral-sh/setup-uv` step anywhere in the job. `uv` is not on the
GitHub runner image. The job is guarded on `services/brain/src/brain/eval` existing, which it does
not, so the step never runs.

**`nightly.yml`, the `cost-accuracy` job.** It runs `node scripts/pricing/verify-snapshot.mjs` with no
`setup-node` and no `pnpm install`. Node is on the runner image, so this one would get further before
failing on a missing dependency, and the script does not exist either.

**`gate-perf.yml`, the retrieval-latency job.** It runs `python -m brain.eval.assert_budget bench.json
--p95-ms 250`. There is no `assert_budget` module under `services/brain/src/brain/`, and no `eval`
package at all. It is guarded on `services/brain/tests/bench` existing.

`docs/DELIVERY.md` states the principle these violate, and states it in the context of a real incident:

> A guard must name **the artefact the job actually consumes**, not a neighbouring directory that
> happens to appear around the same time. [...] A gate that fails for an unrelated reason is worse
> than one that is switched off, because it teaches everyone to read a red check as noise, and that
> is how a real failure gets waved through.

These are the same failure in a different position. The guard is correct — it names the artefact — but
the job body is missing the toolchain the artefact needs. Guarding on `brain/eval` existing is exactly
right; setting up `uv` only when `brain/eval` exists is not, because the setup step is what makes the
guarded body runnable.

`docs/issues/ROADMAP.md` Phase 3 lands the retrieval evaluation harness and Phase 1 lands the price
snapshot verification. Repairing the workflows now costs one small pull request and removes a
mis-attributed failure from each of those.

Spec: `docs/DELIVERY.md`

### Contract

Every job that runs a Python entry point sets up `uv` unconditionally, before its guard:

```yaml
- uses: astral-sh/setup-uv@<pinned sha>
  with:
    enable-cache: true
- id: exists
  run: |
    if [ -d services/brain/src/brain/eval ]; then
      echo "found=true" >> "$GITHUB_OUTPUT"
    else
      echo "found=false" >> "$GITHUB_OUTPUT"
      echo "::notice::brain.eval does not exist yet; retrieval evaluation is inert."
    fi
- if: steps.exists.outputs.found == 'true'
  run: uv sync --directory services/brain --all-extras
- if: steps.exists.outputs.found == 'true'
  run: uv run --directory services/brain python -m brain.eval.harness --dataset golden --fail-on-regression 3
```

Every job that runs a repository script uses the shared composite action, which is the one place
Node, pnpm and the install are defined:

```yaml
- uses: ./.github/actions/setup-node
```

`gate-perf.yml`'s retrieval budget assertion names a module that will exist. Its contract is fixed
here so the Phase 3 issue that writes it has a target rather than a choice:

```python
# services/brain/src/brain/eval/assert_budget.py
#
# Read a pytest-benchmark JSON report and fail when a named percentile exceeds
# its budget. Exits 1 with the measured and permitted figures on stdout.
def main(argv: list[str]) -> int: ...
# usage: python -m brain.eval.assert_budget <report.json> --p95-ms <int>
```

### Files

- `.github/workflows/nightly.yml` — MODIFY: add `astral-sh/setup-uv` to `rag-eval` and
  `./.github/actions/setup-node` to `cost-accuracy`, both before the guard; add `uv sync` to
  `rag-eval`'s guarded branch.
- `.github/workflows/gate-perf.yml` — MODIFY: add `astral-sh/setup-uv` and a guarded `uv sync` to the
  retrieval-latency job.
- `.github/workflows/codeql.yml` — MODIFY: remove the "Skip Python until the brain service exists"
  guard, which has been permanently true since the skeleton landed and now only hides Python from
  analysis.
- `docs/DELIVERY.md` — MODIFY: extend the guard paragraph to say that setup steps sit outside the
  guard and only the body it protects sits inside.

### Acceptance Criteria

- [ ] `rag-eval` sets up `uv` on every run, whether or not its guard passes.
- [ ] `cost-accuracy` sets up Node through the shared composite action on every run.
- [ ] The retrieval-latency job sets up `uv` and syncs the brain project before invoking it.
- [ ] Each guarded job still passes, with a notice, while its artefact is absent.
- [ ] CodeQL analyses Python.
- [ ] No job's guard is loosened; each still names the artefact it consumes.

### Required Tests

- No unit test; these are workflow definitions and their assertion is a run.
- `workflow_dispatch` on `nightly.yml` completes green with three notices, proving the toolchains are
  present and the guards are still closed.
- A scratch branch adding an empty `services/brain/src/brain/eval/__init__.py` and a trivial
  `harness.py` makes `rag-eval` execute its body rather than fail on a missing `uv`, which is the
  regression this issue prevents. The branch is not merged.
- `actionlint` reports no error on the three modified workflows.

### Performance Budget

Adding `setup-uv` with caching costs roughly 10 seconds per job on a warm cache. The nightly run has
no budget; `gate-perf.yml` is on the pull-request path and must stay inside its current wall clock.

### Out of Scope

- Writing `brain.eval.harness`, `brain.eval.assert_budget` or `scripts/pricing/verify-snapshot.mjs`.
  Their contracts are fixed here; the implementations belong to the phases that need them.
- The golden retrieval dataset.
- `deploy.yml`, which has a different problem and its own issue.
- Changing any budget figure.

### Dependencies

none

### Verification

```bash
actionlint .github/workflows/nightly.yml .github/workflows/gate-perf.yml .github/workflows/codeql.yml
gh workflow run nightly.yml --ref "$(git branch --show-current)"
gh run watch
```

The nightly run must be green and its log must carry the three `::notice::` lines. Then confirm the
repair is real by pushing the scratch branch described above and watching `rag-eval` reach its body.
