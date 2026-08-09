---
title: '[ci] Gates must guard on the artefact they check, not on a neighbouring directory'
labels: tier:2, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

Creating `services/brain` as an empty skeleton turned two gates from inert to failing, and neither
failure was about the change that triggered it.

`openapi-drift` runs `pnpm run generate:api-client` whenever `services/brain/pyproject.toml` exists.
That script has never existed, so the job fails with "command not found" the moment the Python
project appears, and will keep failing until an unrelated epic writes an OpenAPI generator.

`retrieval-latency` runs a benchmark from `services/brain/tests/bench` under the same condition.
That directory belongs to the retrieval epic and is several issues away.

The guards were written when `services/brain` was the only marker available, and they conflated "the
Python project exists" with "the thing this gate measures exists". The two are not the same, and the
gap between them is now several epics wide.

A gate that fails for a reason unrelated to the change under review is worse than one that is
switched off. It trains everyone to read a red check as noise, which is exactly how a real failure
gets waved through.

Spec: `docs/DELIVERY.md`

### Contract

Each guard tests for the artefact the job actually consumes:

```bash
# openapi-drift: the generator itself, not the service it would describe.
if node -e "process.exit(require('./package.json').scripts?.['generate:api-client'] ? 0 : 1)"; then

# retrieval-latency: the benchmark suite it runs.
if [ -d services/brain/tests/bench ]; then
```

The job must still appear and report success when its guard is false, because the ruleset requires
these checks by name and a skipped job never reports.

### Files

- MODIFY `.github/workflows/gate-contract.yml` - guard `openapi-drift` on the generator script
- MODIFY `.github/workflows/gate-perf.yml` - guard `retrieval-latency` on the benchmark directory
- MODIFY `docs/DELIVERY.md` - state the rule that a guard names the artefact it consumes

### Acceptance Criteria

- [ ] `openapi-drift` passes on a branch that has `services/brain` but no `generate:api-client` script
- [ ] `retrieval-latency` passes on a branch that has `services/brain` but no `tests/bench` directory
- [ ] Both jobs still report a status rather than being skipped when their guard is false
- [ ] Both jobs run their real work once the artefact they name exists
- [ ] No other gate guards on a path it does not itself consume

### Required Tests

- `openapi drift passes without a generator` - the job reports success with a notice on this PR
- `retrieval latency passes without a benchmark suite` - the job reports success with a notice on this PR
- `every remaining guard names an artefact the job consumes` - audit each `Decide whether to run`
  step in `.github/workflows` and record the result on the pull request

### Performance Budget

n/a

### Out of Scope

- Do not write the OpenAPI generator or the retrieval benchmark; this issue only corrects when the
  gates fire
- Do not convert any guard into a job-level `if:`, which would report `skipped` and leave a required
  check permanently pending
- Do not remove either job from the ruleset's required checks

### Dependencies

none

### Verification

```bash
gh pr checks <this PR> --watch
gh run view <gate-contract run> --log | grep -i "openapi"
gh run view <gate-perf run> --log | grep -i "latency"
```

### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
