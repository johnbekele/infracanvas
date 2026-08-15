---
title: '[ci] Retire the ungated Pages deploy'
labels: tier:1, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

`.github/workflows/deploy.yml` builds `apps/web` and publishes it to GitHub Pages. It triggers on
`push` to `main` and on `workflow_dispatch`. Its only `needs:` is its own internal `build` job.

It therefore depends on no gate. It is not among the 25 contexts `.github/rulesets/main.json`
requires, so it neither blocks a merge nor is blocked by one; it simply fires when a commit lands and
publishes whatever that commit contained. In the ordinary path this is harmless, because `main` is
protected and a merged commit has passed the gates on its pull request. It stops being harmless in
exactly the situation the gates exist for: `bypass_actors` grants the repository admin `always`
bypass, and `docs/DELIVERY.md` records that the admin bypass has been used. A commit that reached
`main` without passing the gates is published by this workflow without anything noticing.

There is also nothing on the other end. GitHub Pages has never been enabled for the repository, so
every run of this workflow has failed at the deploy step. Open issue #43 asks whether it should exist
at all, and notes that Vercel already serves the application — `vercel.json` at the root builds
`@infracanvas/web` into `apps/web/dist`, and `README.md` documents Vercel plus Render as the
deployment shape.

So the workflow publishes nothing, to a surface nobody uses, from a trigger that respects no gate.
Two of those three are reasons to delete it and the third is a reason not to keep it as a template.

Deleting rather than gating is the right call because the alternative — adding `needs:` on the gate
jobs — cannot be expressed. The gates run on `pull_request` and `merge_group`; `deploy.yml` runs on
`push`. There is no completed check to depend on at that point, so a correct gated deploy would have
to re-run the gates on `main`, which doubles CI cost to re-derive an answer the merge already
established. Deployment on this project belongs to the hosting providers, which build from the branch
after the merge, and that is already how it works.

The `pages: write` and `id-token: write` permissions go with it. A workflow file holding those
permissions is worth removing on its own once nothing needs them.

Closes #43.

Spec: `docs/DELIVERY.md`

### Contract

No code contract. After this issue:

- `.github/workflows/` contains no workflow triggered by `push` to `main` that publishes anything.
- No workflow in the repository requests the `pages` or `id-token` permission.
- `release.yml` is untouched: it triggers on a `v*` tag, publishes `@infracanvas/core` to npm and
  creates a GitHub Release, and a tag is a deliberate act rather than a side effect of merging.

### Files

- `.github/workflows/deploy.yml` — DELETE
- `docs/DELIVERY.md` — MODIFY: state in the deployment note that the hosting providers build from
  `main` after merge, and that the repository publishes nothing itself except a tagged release.
- `README.md` — MODIFY: only if it references the Pages deploy. It documents Vercel and Render, so
  confirm and leave otherwise.

### Acceptance Criteria

- [ ] `deploy.yml` is removed.
- [ ] No remaining workflow triggers on `push` to `main` and publishes.
- [ ] No remaining workflow requests `pages: write` or `id-token: write`.
- [ ] `release.yml` still runs on a `v*` tag and is unmodified.
- [ ] Issue #43 is closed by this pull request.
- [ ] The 25 required contexts in `.github/rulesets/main.json` are unchanged, because `deploy.yml` was never among them.

### Required Tests

- No unit test; this is a workflow deletion.
- A grep across `.github/workflows/` must return no `pages: write`, no `id-token: write`, and no
  `push: branches: [main]` trigger on a publishing job.
- The gates must pass on the pull request that removes it, proving nothing else referenced it.
- After merge, the run list for `main` must show no `Deploy to GitHub Pages` run, which is the
  observable confirmation.

### Performance Budget

n/a

### Out of Scope

- Vercel and Render configuration. Both are outside CI and neither changes here.
- The duplicated static-hosting configuration: there is a `vercel.json` at the root and another at
  `apps/web/vercel.json`, with different build commands. Real, confusing, and its own issue.
- `release.yml`, including that it runs `pnpm build` twice and sets up pnpm inline rather than through
  the shared composite action.
- Whether the project should publish documentation anywhere.

### Dependencies

none

### Verification

```bash
ls .github/workflows/deploy.yml 2>&1
grep -rn "pages: write\|id-token: write" .github/workflows/ || echo "no pages permissions remain"
grep -rln "branches: \[main\]" .github/workflows/
actionlint .github/workflows/*.yml
```

The `ls` must report the file missing, the permission grep must find nothing, and the branch grep must
return only workflows that test rather than publish. After merge, confirm no Pages run appears:

```bash
gh run list --branch main --limit 20
```
