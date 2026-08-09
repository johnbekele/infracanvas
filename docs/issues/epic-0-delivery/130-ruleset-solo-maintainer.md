---
title: '[ci] Stop requiring an approval nobody is able to give'
labels: tier:1, size:s, area:ci, epic:0-delivery
---

### Epic

#1

### Context

The ruleset on `main` requires one approving review including a code owner. `CODEOWNERS` names the
sole maintainer, who is also the author of every pull request in the repository, and GitHub does not
permit self-approval. Every open pull request reports `mergeStateStatus: BLOCKED` with
`reviewDecision: REVIEW_REQUIRED`, and no sequence of events reaches a mergeable state.

The only way through is the admin bypass, which `CLAUDE.md` forbids in as many words: "Never bypass a
gate with `--no-verify` or an admin merge."

A rule that can be satisfied only by breaking another rule is not a quality bar. What it actually
produces is a habit of reaching for `--admin`, and that habit costs far more than the review was ever
worth, because the next override will be the one that matters.

The 25 required status checks are the part doing real work here. They are mechanical, they cannot be
waved through, and they stay exactly as they are.

Spec: `docs/DELIVERY.md`

### Contract

```json
{
  "required_approving_review_count": 0,
  "require_code_owner_review": false
}
```

Every other parameter is unchanged, including `required_review_thread_resolution`, the squash-only
merge method, and all 25 required status checks.

### Files

- MODIFY `.github/rulesets/main.json` - drop the approval requirement
- MODIFY `docs/DELIVERY.md` - record why, and the condition for restoring it

### Acceptance Criteria

- [ ] A pull request with every gate green reports `mergeStateStatus: CLEAN`
- [ ] A pull request with any gate failing is still blocked
- [ ] All 25 required status checks remain required, verified against the live ruleset
- [ ] `required_review_thread_resolution` stays true, so an unresolved comment still blocks
- [ ] Squash remains the only permitted merge method
- [ ] `docs/DELIVERY.md` states the condition under which approval is restored

### Required Tests

- `a green pull request becomes mergeable` - `gh pr view <n> --json mergeStateStatus` reports `CLEAN`
- `a red pull request stays blocked` - the same query on a pull request with a failing gate reports
  `BLOCKED`
- `the required check list is unchanged` - diff the live ruleset's check names against `main.json`

### Performance Budget

n/a

### Out of Scope

- Do not remove or weaken any status check
- Do not remove `CODEOWNERS`; it still routes review requests, it simply no longer blocks
- Do not touch the admin bypass entry, which exists for recovery rather than routine merging

### Dependencies

none

### Verification

```bash
node scripts/gh/apply-ruleset.mjs
gh api repos/johnbekele/infracanvas/rulesets/<id> \
  --jq '.rules[] | select(.type=="pull_request") | .parameters'
gh pr view <n> --json mergeStateStatus,reviewDecision
```

### Risk Tier

tier:1 - the gates themselves

### Size

size:s - under 200 lines
