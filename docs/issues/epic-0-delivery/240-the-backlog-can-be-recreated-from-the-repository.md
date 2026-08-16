---
title: '[ci] Extend label, milestone and epic seeding to cover every epic'
labels: tier:3, size:m, area:ci, epic:0-delivery
---

### Epic

#1

### Context

`docs/issues/README.md` gives the reason issues are files rather than form submissions:

> a contract belongs under version control with everything else it governs: it can be reviewed in a
> pull request before anyone starts work, its history explains why a requirement changed, and the
> whole backlog can be recreated if the repository ever is.

The last clause is not true today, and it fails quietly.

`.github/labels.yml` declares thirteen epic labels, `epic:0-delivery` through `epic:12-launch`.
`scripts/gh/seed-epics.mjs` creates thirteen epic tracking issues and `scripts/gh/seed-milestones.mjs`
thirteen milestones, both stopping at Epic 12. But GitHub carries two more epics — #117 Architecture
copilot, labelled `epic:13-agent`, and #118 MCP server, labelled `epic:14-mcp` — with children under
each. Those labels exist on GitHub and are absent from the declared source of truth.

`seed-labels.mjs` cannot notice. It reads `.github/labels.yml`, creates or updates what it finds, and
leaves labels it does not recognise alone — which is the right behaviour for a tool that should not
delete a label somebody added deliberately, and which means the drift is invisible. Seeding a fresh
repository from this checkout produces thirteen epics, thirteen milestones, thirteen labels, and no
home for the two epics' worth of work.

`docs/issues/ROADMAP.md` adds three more: `epic:15-tenancy`, `epic:16-governance` and
`epic:17-simcore`. Their specs cannot be seeded until the labels and tracking issues exist, so this
issue blocks every Phase 1 issue.

Two things are being fixed, and only one is arithmetic. Extending the three scripts to seventeen is
mechanical. Making the drift _detectable_ is the part that stops this recurring: a check that compares
the epic labels on GitHub with the ones declared in `.github/labels.yml` and fails when they disagree
turns a silent divergence into a red run. Without it, the next epic added through the web interface
reintroduces exactly this state.

Epic 13 is a special case. `docs/issues/ROADMAP.md` keeps the copilot in TypeScript under
`apps/api/src/lib/copilot/` rather than moving it to the Python brain, so the epic remains live and
its label is declared like any other; what changes is the content of its specs, not its existence.

Spec: `docs/issues/README.md`

### Contract

```yaml
# .github/labels.yml — five additions, matching the existing epic label shape
- name: 'epic:13-agent'
  color: '5319e7'
  description: 'Architecture copilot and typed patches'
- name: 'epic:14-mcp'
  color: '5319e7'
  description: 'MCP server over the copilot tools'
- name: 'epic:15-tenancy'
  color: '5319e7'
  description: 'Organizations, workspaces, RBAC and API keys'
- name: 'epic:16-governance'
  color: '5319e7'
  description: 'Audit, approvals, policy and budgets'
- name: 'epic:17-simcore'
  color: '5319e7'
  description: 'The Rust simulation core and its bindings'
```

```javascript
// scripts/gh/check-epic-drift.mjs
/**
 * Compare the epic labels GitHub carries with the ones declared in
 * .github/labels.yml. Declared-but-absent is created by the seeder and is not
 * an error; present-but-undeclared is drift and is.
 */
export function drift(declared, actual) {
  return { undeclared: [], missing: [] };
}
```

`seed-epics.mjs` gains entries 13 to 17 in its existing shape — Goal, Contracts Introduced, Tasks,
Exit Criteria, Wave — and `seed-milestones.mjs` gains the matching five milestones. The wave field
follows `docs/issues/ROADMAP.md`: 15 and 16 in Wave 1, 17 in Wave 2, 13 and 14 in Wave 4.

### Files

- `.github/labels.yml` — MODIFY: declare the five epic labels above, plus `security-reviewed` and
  `coverage-ratchet-lowered` if their own issues have not already added them.
- `scripts/gh/seed-epics.mjs` — MODIFY: add tracking issues for epics 13 to 17.
- `scripts/gh/seed-milestones.mjs` — MODIFY: add the five milestones.
- `scripts/gh/check-epic-drift.mjs` — CREATE: the comparison above.
- `scripts/gh/check-epic-drift.test.mjs` — CREATE: the cases below.
- `.github/workflows/gate-static.yml` — MODIFY: run the drift check as a job that always runs and
  guards internally on `gh` being authenticated, so a fork without credentials reports a notice
  rather than failing.
- `docs/issues/README.md` — MODIFY: extend the directory-to-epic table to seventeen rows, and correct
  the existing `epic-11-web` row, whose directory does not match its `epic:11-ui` label.
- `docs/issues/ROADMAP.md` — MODIFY: fill in the three tracking issue numbers once seeded.

### Acceptance Criteria

- [ ] `.github/labels.yml` declares every epic label that exists on GitHub.
- [ ] `pnpm gh:labels` is a no-op on a repository already in the declared state.
- [ ] `pnpm gh:epics` and `pnpm gh:milestones` create epics and milestones 13 to 17 and update rather than duplicate on a second run.
- [ ] The drift check fails when an epic label exists on GitHub and is not declared.
- [ ] The drift check passes when the two agree, and reports a notice rather than failing where `gh` is unauthenticated.
- [ ] `docs/issues/README.md`'s table lists all seventeen directories and their labels correctly.
- [ ] Seeding a fresh repository from this checkout reproduces every epic, milestone and label.

### Required Tests

- `reports an undeclared epic label as drift` — GitHub has `epic:18-something`, the file does not: one
  entry under `undeclared`.
- `does not report a declared label the seeder will create` — the file has a label GitHub lacks: it
  appears under `missing`, which is not a failure, because `pnpm gh:labels` is what fixes it.
- `passes when the two agree` — both problems empty.
- `ignores non-epic labels` — `tier:1`, `area:api` and `good-first-issue` are outside this check's
  concern and must not be reported either way.
- `seed-epics.mjs defines a tracking issue for every declared epic label` — a test over the two files
  asserting they cover the same set, so adding a label without an epic, or the reverse, fails here
  rather than on GitHub.

### Performance Budget

The drift check is one `gh label list` call and must finish in under 15 seconds. It runs on every pull
request as part of Gate 2.

### Out of Scope

- Writing the specs for epics 15 to 17. They are separate files under their own directories.
- Renumbering any epic. `docs/issues/ROADMAP.md` states the reason: numbers are identifiers, and
  roughly seventy open issues carry `Epic #N` that Gate 0 requires.
- Retiring or merging any epic.
- The colliding numeric prefixes in `docs/issues/epic-0-delivery/`, which have their own issue.
- Triage of the existing open issues against the redesign.

### Dependencies

none

### Verification

```bash
pnpm gh:labels --dry-run
pnpm gh:milestones --dry-run
pnpm gh:issues --dry-run
node --test scripts/gh/check-epic-drift.test.mjs
node scripts/gh/check-epic-drift.mjs
```

Every dry run must report only the intended additions. Then seed for real and confirm idempotence by
running each a second time and seeing no change:

```bash
pnpm gh:labels && pnpm gh:milestones && pnpm gh:labels
```

Confirm the identity used is the personal account before any of this touches GitHub:

```bash
gh api user --jq .login
```
