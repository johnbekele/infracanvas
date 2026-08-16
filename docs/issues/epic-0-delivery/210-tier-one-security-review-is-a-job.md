---
title: '[ci] Make the tier-one security review a check rather than a label'
labels: tier:1, size:m, area:ci, epic:0-delivery
---

### Epic

#1

### Context

`docs/DELIVERY.md` describes Gate 7 as blocking on _"PR hygiene, risk-tier routing, security review on
tier 1"_, and its risk-tier table says tier 1 _"requires a passing security review job"_. No such job
exists.

`.github/workflows/gate-review.yml` has two jobs. `hygiene` runs `check-pr-hygiene.mjs`. `tier-routing`
derives the tier from the paths the diff touches:

```
^(apps/api/src/routes/auth/|apps/api/src/lib/(encryption|jwt)\.ts|apps/api/src/middleware/|infra/|services/brain/src/brain/codegen/|\.github/)
```

and on a hit applies the `tier:1` and `needs:security-review` labels. It applies labels and exits
zero. Nothing consults them, `.github/rulesets/main.json` lists no security-review context among its
25 required checks, and `required_approving_review_count` is 0 — for reasons `docs/DELIVERY.md`
explains honestly and which are not in dispute here.

So today a pull request that rewrites `apps/api/src/middleware/auth.ts` is labelled and merges. The
label is a note to a reviewer who, by the repository's own admission, is the same person who opened
it. That is a gap between what the delivery document promises and what the gates do, and the document
is the thing agents and contributors read to know what is enforced.

This matters immediately rather than eventually. Phase 0 already contains three tier-1 issues that
touch exactly those paths — the session revocation bypass, the AWS key environment variables, and the
cross-site cookie — and Phase 7 is tier 1 throughout, because it spends money in a customer's AWS
account.

The design has to respect the constraint that made approval unenforceable: a solo maintainer cannot
be made to sign their own work. So the job does not demand a second human. It demands that the
security-relevant change was **looked at deliberately and the reasoning recorded**, which a single
maintainer can supply and which leaves an artefact a later reader can audit. Concretely: a tier-1 pull
request must carry a `## Security review` section answering four fixed questions, and must carry the
`security-reviewed` label, which the job itself refuses to accept as sufficient on its own — the
section must be present and non-placeholder too, so the label cannot be applied reflexively.

Per `docs/DELIVERY.md`, the job **always runs and decides internally**, because a job skipped by a
job-level `if` reports `skipped` and a required skipped check leaves a pull request permanently
unmergeable. On a tier-2 or tier-3 diff it reports that no security review is required and passes.

Spec: `docs/DELIVERY.md`

### Contract

```javascript
// scripts/ci/check-security-review.mjs

/** Paths whose change requires a recorded security review. Kept identical to
 *  the tier-routing regex in gate-review.yml; a test asserts they agree. */
export const TIER_ONE_PATHS: RegExp;

/** The four questions a tier-one pull request must answer. */
export const REQUIRED_QUESTIONS: readonly string[];

/**
 * @param {string[]} changedFiles
 * @param {string}   body   the pull request body
 * @param {string[]} labels
 * @returns {{ tier: 1 | 2 | 3, problems: string[] }}
 */
export function review(changedFiles, body, labels);
```

The four questions, matched case-insensitively as headings or bolded lines inside `## Security review`:

1. **What could an attacker do with this change that they could not do before?**
2. **What is the blast radius if this is wrong?**
3. **What did you verify, and how?**
4. **What did you decide not to address, and why is that acceptable?**

`review` returns problems when, and only when, the diff is tier 1 and any of these hold: the
`## Security review` section is absent; a question is unanswered or answered with placeholder text
matching `check-issue-spec.mjs`'s `PLACEHOLDER` pattern; or the `security-reviewed` label is absent.

```yaml
# .github/workflows/gate-review.yml
security-review:
  name: Security review
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@<pinned sha>
      with: { fetch-depth: 0 }
    - run: node scripts/ci/check-security-review.mjs
      env:
        PR_NUMBER: ${{ github.event.pull_request.number }}
        BASE_REF: ${{ github.event.pull_request.base.ref || 'main' }}
        REPO: ${{ github.repository }}
```

### Files

- `scripts/ci/check-security-review.mjs` — CREATE: the tier derivation, the section parser, the
  verdict, and a `main` that reads the pull request through `gh` exactly as `check-issue-spec.mjs`
  does.
- `scripts/ci/check-security-review.test.mjs` — CREATE: the cases below.
- `.github/workflows/gate-review.yml` — MODIFY: add the `security-review` job; have `tier-routing`
  import `TIER_ONE_PATHS` from the script rather than restating the regex inline.
- `.github/PULL_REQUEST_TEMPLATE.md` — MODIFY: add a `## Security review` section, marked as required
  only for tier 1, carrying the four questions.
- `.github/labels.yml` — MODIFY: add `security-reviewed`.
- `docs/DELIVERY.md` — MODIFY: describe what the job actually enforces, replacing the promise of a
  second signature with the recorded-reasoning requirement.

### Acceptance Criteria

- [ ] A pull request touching a tier-one path without a `## Security review` section fails the job.
- [ ] A pull request touching a tier-one path with the section but without the `security-reviewed` label fails.
- [ ] A pull request touching a tier-one path with an unanswered or placeholder question fails, naming the question.
- [ ] A pull request touching a tier-one path with all four answered and the label passes.
- [ ] A pull request touching no tier-one path passes and says no security review was required.
- [ ] The job runs on every pull request and never reports `skipped`.
- [ ] `tier-routing` and `check-security-review.mjs` derive tier one from one shared definition.

### Required Tests

- `derives tier one from an auth middleware change` — `apps/api/src/middleware/auth.ts` yields tier 1.
- `derives tier one from a workflow change` — `.github/workflows/gate-test.yml` yields tier 1, because
  the gates are in the tier-one path set by design.
- `derives tier two from ordinary application code` — `apps/web/src/pages/LandingPage.tsx` yields
  tier 2 and no problems, whatever the body says.
- `requires the section on a tier one diff` — tier-one files, empty body, `security-reviewed` present:
  one problem naming the missing section.
- `requires every question` — three of four answered: one problem naming the fourth.
- `rejects a placeholder answer` — a question answered `TBD` is treated as unanswered, reusing the
  `PLACEHOLDER` pattern so the two gates agree on what an empty answer looks like.
- `requires the label as well as the section` — a complete section without `security-reviewed` fails,
  so the section cannot be pasted without anyone confirming it.
- `passes a complete tier one review` — all four answered plus the label: no problems.
- `the routing regex and the script agree` — asserts the regex in `gate-review.yml` is the one the
  script exports, so the two cannot drift into disagreeing about what tier 1 means.

### Performance Budget

The job is one checkout and one `gh` call and must finish inside 30 seconds, matching `hygiene`. It is
on the critical path of every pull request.

### Out of Scope

- Restoring `required_approving_review_count` to 1. `docs/DELIVERY.md` sets the condition for that — a
  second maintainer, or agent pull requests opened by a separate account — and neither holds yet.
- Adding `Security review` to `.github/rulesets/main.json`. Per `docs/DELIVERY.md`, a context is
  required only after it has reported at least once; that is a follow-up pull request.
- Automated security analysis. CodeQL and Gate 5 already do that; this job is about recorded human
  judgement on a change that warrants it.
- Widening or narrowing the tier-one path set.

### Dependencies

none

### Verification

```bash
node --test scripts/ci/check-security-review.test.mjs
```

Then exercise both verdicts on real pull requests: this issue's own pull request touches
`.github/`, so it is tier 1 and must be made to pass by carrying its own completed security review —
which is the most direct possible demonstration that the job works. A scratch pull request touching
only `apps/web/src/pages/` must pass without one.
