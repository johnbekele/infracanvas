---
title: '[ci] Keep agent-ready issue specifications as files in the repository'
labels: tier:3, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

An agent picking up an issue reads only that issue and the spec it links, which makes the issue text
the engineering contract for that unit of work. Right now that contract is typed into the GitHub
issue form, where it has no review, no history explaining why a requirement changed, and no way to
be recreated if the repository is lost or rebuilt.

Reviewing a contract before anyone implements it is far cheaper than reviewing the implementation
that resulted from a bad one. That review needs the contract to be a diff.

There is a second, smaller problem. Gate 0 rejects an incomplete issue by labelling it `needs-spec`
and commenting on it. That is the right behaviour for an issue a human wrote by hand, but when a
batch is created programmatically it means a round trip per issue and a rejection comment sitting on
an issue nobody has read. The same validation should be available before the issue exists.

Spec: `docs/issues/README.md`

### Contract

Issue files carry a `---` frontmatter header followed by the same `### Heading` sections that
`.github/ISSUE_TEMPLATE/agent-task.yml` produces:

```typescript
interface IssueSpecFile {
  /** Frontmatter. `labels` is comma separated; every other key is a plain string. */
  readonly title: string;
  readonly labels?: string;
  /** Everything after the closing `---`, in issue-form section format. */
  readonly body: string;
}
```

`scripts/ci/check-issue-spec.mjs` exports its validation so it can run against a file:

```typescript
export function parseSections(body: string): Map<string, string>;
export function validate(sections: Map<string, string>, body: string): string[];
```

It must continue to exit with the correct status when invoked directly, which is how CI calls it.

`scripts/gh/seed-issues.mjs` creates or updates issues from `docs/issues/**`, matching on title so a
second run updates rather than duplicates. It supports `--dry-run` and `--epic <n>`, and refuses to
create anything if any file would fail Gate 0.

### Files

- CREATE `scripts/gh/seed-issues.mjs`
- CREATE `docs/issues/README.md`
- CREATE `docs/issues/epic-0-delivery/110-issue-specs-as-files.md`
- CREATE `docs/issues/epic-1-data/*.md` (the ten Epic 1 specifications)
- MODIFY `scripts/ci/check-issue-spec.mjs` - export the parser and validator, guard `main()`
- MODIFY `package.json` - add the `gh:issues` script

### Acceptance Criteria

- [ ] `pnpm gh:issues --dry-run` reports what would change without calling the GitHub write API
- [ ] Running the seeder twice updates the existing issues rather than creating duplicates
- [ ] A file that would fail Gate 0 stops the run, and nothing is created
- [ ] A title containing a comma survives frontmatter parsing intact
- [ ] `--epic 1` restricts the run to `docs/issues/epic-1-*`
- [ ] `check-issue-spec.mjs` invoked directly still exits 0 for a complete issue and 1 for an incomplete one
- [ ] Every issue the seeder creates is labelled `agent-ready` by Gate 0 without manual edits

### Required Tests

- `dry run makes no write calls` - verified by running against the live repository with no changes resulting
- `a second run updates instead of duplicating` - re-run reports `update`, and the issue count is unchanged
- `a title containing a comma is not split` - the "Experiment, deployment, and artifact tables" title
  round-trips, which it did not before the frontmatter parser distinguished list keys
- `an invalid spec blocks the whole run` - validation runs before any create call
- `direct invocation still gates correctly` - `ISSUE_NUMBER=... node scripts/ci/check-issue-spec.mjs` exits 0

### Performance Budget

n/a

### Out of Scope

- Do not change Gate 0's validation rules; this issue only makes them reusable
- Do not change the issue template, the label taxonomy, or the ruleset
- Do not add a YAML dependency for the frontmatter; the header is a handful of scalars
- Do not delete or rewrite issues that already exist on GitHub

### Dependencies

none

### Verification

```bash
node scripts/gh/seed-issues.mjs --dry-run
pnpm gh:issues
node scripts/gh/seed-issues.mjs --dry-run   # every line now reads "update"
ISSUE_NUMBER=22 REPO=johnbekele/infracanvas node scripts/ci/check-issue-spec.mjs
pnpm lint
```

### Risk Tier

tier:3 - docs or tests only

### Size

size:s - under 200 lines
