# Rulesets

Branch protection lives here rather than in the repository settings UI, so a change to the rules of
the project is reviewable in a pull request like any other change.

Apply with:

```bash
pnpm gh:ruleset            # apply main.json
pnpm gh:ruleset --dry-run  # print what would change
```

## Gate 8: the merge queue

`main.json` deliberately does **not** contain a `merge_queue` rule. The REST API rejects it on this
repository with `422 Validation Failed: Invalid rule 'merge_queue'` and no further detail, despite
the repository being public and the parameters matching the documented schema.

Rather than guess at the cause, the queue is left off. It is the least valuable gate at the current
pull request volume: its purpose is to stop semantically conflicting changes from landing together
when many pull requests merge per day, and the protections that matter (required checks, code owner
review, no force push, no deletion) are all active without it.

Everything needed for a queue that does not stall is already in place, so enabling it later is a
settings change rather than a workflow rewrite:

- every required check also triggers on `merge_group`
- every gate job always runs and guards internally, so no required check reports `skipped`

To enable it, turn on the merge queue for `main` under Settings then Rules, and add the rule back to
`main.json` so the file continues to describe reality.

## Why repository admins can bypass

`bypass_actors` grants the repository admin role an always-on bypass. Without it this repository
becomes unmergeable rather than merely strict: the ruleset requires an approving review from a code
owner, GitHub does not let an author approve their own pull request, and `CODEOWNERS` lists a single
maintainer. Every pull request the maintainer opens would wait forever for an approval nobody can
give.

The bypass applies to the human maintainer only. It does not weaken the parts that catch real
defects, because status checks still run on every pull request and are still reported, and outside
contributors still need a code owner review. The honest description is that review is enforced for
contributors and self-imposed for the maintainer.

Remove this bypass as soon as a second maintainer exists.

## A required check must report before it can be required

GitHub only enforces a status check it has seen at least once. After adding a new gate job, let it
run on one pull request before adding its name to `required_status_checks`, or the ruleset will
reference a check that never arrives.
