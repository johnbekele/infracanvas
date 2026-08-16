---
title: '[ci] Produce and keep coverage reports, without enforcing them yet'
labels: tier:3, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

Gate 3 claims to block on _"85% coverage of changed lines"_. It has never measured anything, and the
cause is not the one it looks like.

The `coverage` job in `.github/workflows/gate-test.yml` guards itself with:

```bash
if ! ls coverage.xml **/coverage*.xml >/dev/null 2>&1; then
  echo "::notice::No coverage reports produced yet; gate is inert."
  exit 0
fi
```

Three independent faults sit behind that notice, and fixing any one alone changes nothing:

1. **No coverage report is ever produced.** Neither `apps/web/vitest.config.ts`,
   `apps/api/vitest.config.ts` nor `apps/api/vitest.integration.config.ts` enables a coverage
   reporter, and the Node test job runs plain `turbo test`. The Python job does pass
   `--cov-report=xml`, and the Rust job produces nothing.
2. **The job could not see a report if one existed.** `coverage` is a separate job with its own
   `actions/checkout`. It runs on a fresh runner and there is no `upload-artifact` anywhere in the
   workflow and no `download-artifact` in the job, so its working directory holds the repository and
   nothing else.
3. **The glob is wrong.** `**/coverage*.xml` in `bash` without `shopt -s globstar` behaves as
   `*/coverage*.xml`, matching one directory level, and the Python report lands two levels down under
   `services/brain/`.

`Diff coverage` is one of the 25 contexts `.github/rulesets/main.json` requires. A check that is
required, always green, and measuring nothing is the most expensive kind of broken: it reads as
evidence in every pull request that has ever merged.

Repairing it in one step would take the gate from measuring nothing to demanding 85% of changed lines
across three languages at once, and would red every open pull request the moment it merged. So the
repair is three issues. **This one produces and keeps the reports and changes no verdict** — the job
still passes on anything. The next measures and prints. The third enforces.

Spec: `docs/DELIVERY.md`

### Contract

```typescript
// apps/web/vitest.config.ts, apps/api/vitest.config.ts — added to defineConfig
test: {
  coverage: {
    provider: 'v8',
    reporter: ['cobertura', 'text-summary'],
    reportsDirectory: './coverage',
    enabled: true,
  },
}
```

```yaml
# .github/workflows/gate-test.yml — one upload per producing job
- uses: actions/upload-artifact@<pinned sha>
  if: always()
  with:
    name: coverage-<node|python|rust>
    path: '**/coverage.xml'
    if-no-files-found: warn
    retention-days: 7
```

Every report is Cobertura XML, because `diff-cover` reads Cobertura and it is the one format all
three toolchains emit. Paths inside each report must be repository-relative, or `diff-cover` cannot
match them to the diff.

Rust coverage comes from `cargo llvm-cov --workspace --all-features --cobertura --output-path
coverage.xml`, which requires `cargo-llvm-cov` and the `llvm-tools-preview` component.

### Files

- `apps/web/vitest.config.ts` — MODIFY: enable the v8 coverage provider with a Cobertura reporter.
- `apps/api/vitest.config.ts` — MODIFY: the same.
- `apps/api/vitest.integration.config.ts` — MODIFY: the same, so integration-only lines are credited.
- `.github/workflows/gate-test.yml` — MODIFY: upload a coverage artifact from the Node, Python and
  Rust jobs; add `cargo-llvm-cov` to the Rust job; leave the `coverage` job's verdict untouched.
- `package.json` — MODIFY: add `@vitest/coverage-v8` to `devDependencies`.

### Acceptance Criteria

- [ ] Each of the Node, Python and Rust test jobs uploads a coverage artifact.
- [ ] Every uploaded report is Cobertura XML with repository-relative paths.
- [ ] The `coverage` job's outcome is unchanged: it still passes on every pull request.
- [ ] `pnpm test` locally writes a Cobertura report for the web and API packages.
- [ ] Test wall-clock time in CI grows by no more than 30 seconds.

### Required Tests

- No new unit test; this issue changes build configuration and CI wiring, and its verification is the
  artifacts appearing on a pull request.
- The existing suites must pass unchanged under coverage instrumentation — v8 coverage has been known
  to change behaviour in code that inspects stack traces, so a green run is the assertion.
- A deliberately failing test must still fail the job with coverage enabled, proving instrumentation
  did not swallow the result.

### Performance Budget

Coverage instrumentation adds under 30 seconds to the test gate. `docs/DELIVERY.md` sets no budget for
CI wall clock; this issue establishes 30 seconds as the ceiling for this change so the next two
issues have a baseline to compare against.

### Out of Scope

- Reading, merging or acting on the reports. That is `180-coverage-is-measured-and-reported.md`.
- Any threshold, ratchet or verdict change.
- The `**/coverage*.xml` glob, which is repaired by the job that replaces it in `180`.
- Coverage for `services/brain` integration tests, which need a live Postgres.

### Dependencies

none

### Verification

```bash
pnpm --filter @infracanvas/web exec vitest run --coverage
pnpm --filter @infracanvas/api exec vitest run --coverage
ls apps/web/coverage/cobertura-coverage.xml apps/api/coverage/cobertura-coverage.xml
uv run --directory services/brain pytest -m "not integration" --cov=src --cov-report=xml
cargo llvm-cov --workspace --all-features --cobertura --output-path coverage.xml
```

On the pull request itself, the run must show three coverage artifacts attached and `Diff coverage`
still green.
