---
title: '[ci] Give every spec file the risk tier and size Gate 0 requires'
labels: tier:3, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

Sixteen spec files omit `### Size`, and fourteen of those also omit `### Risk Tier`. Both are
required: `scripts/ci/check-issue-spec.mjs` searches the issue body for `tier:[123]` and `size:[sml]`,
and `scripts/gh/seed-issues.mjs` strips the frontmatter before validating, so the `tier:` and `size:`
entries on the frontmatter `labels:` line are invisible to it. The seventy-one older specs all carry
both sections; only the files added by PR #176 are missing them.

This costs more than the sixteen files suggest, for two reasons.

The seeder validates every spec before writing anything and aborts the whole run if any fail:

```
16 spec file(s) would be rejected by Gate 0. Nothing was created.
```

So `pnpm gh:issues` currently cannot update _any_ issue body, including the seventy-one that are
correct. The documented, idempotent way to publish the backlog is unusable until these sixteen are
fixed, and the only way to work around it is `--epic`, one conforming epic at a time.

The second reason is quieter. The sixteen issues on GitHub (#177 to #192) already carry both sections,
because they were added by hand when the issues were created. The files and the issues have therefore
drifted, and the files are the worse copy. Fixing the validator, or relaxing it, would unblock a run
that then overwrites sixteen good issue bodies with bodies missing their tier and size.

The validator is not at fault and should not be touched. It agrees with
`.github/ISSUE_TEMPLATE/agent-task.yml`, with `.cursor/rules/issue-specs.mdc`, and with every spec
written before PR #176.

### Contract

No new interfaces. Each file gains the two sections the other specs already end with, after
`### Verification`, matching `epic-0-delivery/150-dev-servers-start-from-a-clean-tree.md`:

```markdown
### Risk Tier

tier:2 - normal application code

### Size

size:s - under 200 lines
```

The tier and the size must be the ones already on the frontmatter `labels:` line of the same file, and
already applied as labels to the issue, so that the file, the body and the labels agree. Take the
wording of the trailing clause from the issue body on GitHub, which is the copy that is already right:

```bash
gh issue view <n> --repo johnbekele/infracanvas --json body --jq .body |
  sed -n '/^### Risk Tier/,$p'
```

### Files

- MODIFY `docs/issues/epic-0-delivery/160-remove-the-superseded-root-plans.md` - add both sections
- MODIFY `docs/issues/epic-0-delivery/170-coverage-reports-are-produced-and-kept.md` - add both
- MODIFY `docs/issues/epic-0-delivery/180-coverage-is-measured-and-reported.md` - add both
- MODIFY `docs/issues/epic-0-delivery/190-coverage-is-enforced-at-a-ratchet.md` - add both
- MODIFY `docs/issues/epic-0-delivery/200-the-size-budget-can-see-a-wasm-module.md` - add both
- MODIFY `docs/issues/epic-0-delivery/210-tier-one-security-review-is-a-job.md` - add `### Size` only
- MODIFY `docs/issues/epic-0-delivery/220-scheduled-gates-run-what-they-claim.md` - add both
- MODIFY `docs/issues/epic-0-delivery/230-nothing-publishes-without-passing-the-gates.md` - add both
- MODIFY `docs/issues/epic-0-delivery/240-the-backlog-can-be-recreated-from-the-repository.md` - add
  `### Size` only
- MODIFY `docs/issues/epic-1-data/150-a-signed-token-cannot-outlive-its-revocation.md` - add both
- MODIFY `docs/issues/epic-1-data/160-no-long-lived-cloud-keys-anywhere.md` - add both
- MODIFY `docs/issues/epic-1-data/170-the-session-cookie-survives-a-split-origin.md` - add both
- MODIFY `docs/issues/epic-11-web/090-branch-endpoint-agrees-with-its-client.md` - add both
- MODIFY `docs/issues/epic-15-tenancy/010-organizations-and-workspaces.md` - add both
- MODIFY `docs/issues/epic-2-ir/090-validator-dispatches-every-typed-kind.md` - add both
- MODIFY `docs/issues/epic-7-prediction/060-price-lookup-refuses-an-ambiguous-query.md` - add both

### Acceptance Criteria

- [ ] `pnpm gh:issues --dry-run` completes without rejecting any spec file
- [ ] Every file under `docs/issues/*/` contains a `### Risk Tier` and a `### Size` section
- [ ] The tier in each body matches the `tier:` entry in the same file's frontmatter, and the size
      matches the `size:` entry
- [ ] The tier and size in each file match the labels already applied to the corresponding issue, so a
      subsequent seed does not change any label
- [ ] `pnpm gh:issues --dry-run` reports no body change for the seventy-one specs that were already
      conforming
- [ ] `scripts/ci/check-issue-spec.mjs` is unchanged

### Required Tests

Manual, since this concerns Markdown files and a seeding script rather than a unit:

- `pnpm gh:issues --dry-run` over the whole backlog: expect no rejections, where before it aborted
  with sixteen
- `pnpm gh:issues --dry-run --epic 15`, the smallest failing case: expect the tenancy spec to pass
- A grep asserting the absence of the failure, so a future spec cannot reintroduce it unnoticed:
  `for f in docs/issues/*/*.md; do rg -q '^### Size' "$f" || echo "missing: $f"; done` prints nothing
- Edge case: a file whose frontmatter and new body section disagree, for example `tier:1` in the
  frontmatter and `tier:2` in the body, is a defect this issue must not introduce; check each of the
  sixteen by eye rather than pasting one tier into all of them

### Performance Budget

n/a. Documentation only; no code path changes.

### Out of Scope

- Do not change `scripts/ci/check-issue-spec.mjs`. It is correct, it is a gate, and changing a gate is
  tier 1 and needs its own pull request. Relaxing it to read the frontmatter would unblock a run that
  then overwrites sixteen good issue bodies with worse ones.
- Do not change `scripts/gh/seed-issues.mjs`, including its abort-on-any-failure behaviour, which is
  what stops a partial backlog being published.
- Do not touch the seventy-one specs that already conform.
- Do not change any `title` in frontmatter. The seeder matches by title, so a retitle creates a second
  issue rather than renaming the first.
- Do not edit the issue bodies on GitHub by hand. Once the files are right, the seeder is what
  reconciles them.

### Dependencies

- #176 - the sixteen files exist only on that branch, so this cannot land before it merges. If it is
  reworked rather than merged, fix the files there instead and close this.

### Verification

```bash
pnpm gh:issues --dry-run
pnpm gh:issues --dry-run --epic 15
for f in docs/issues/*/*.md; do
  rg -q '^### Risk Tier' "$f" || echo "no tier: $f"
  rg -q '^### Size' "$f" || echo "no size: $f"
done
```

### Risk Tier

tier:3 - docs only

### Size

size:s - under 200 lines
