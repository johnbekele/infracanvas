<!--
Title must follow Conventional Commits, e.g. `feat(rag): add BM25 retriever`.
Gate 7 fails this PR if any required checkbox below is left unticked.
-->

## Closes

<!-- Required. Gate 7 fails without a closing keyword and issue number. -->

Closes #

## What changed

<!-- What a reviewer needs to understand the diff. Describe behaviour, not file names. -->

## Why this satisfies the contract

<!--
Map each acceptance criterion from the issue to the code or test that satisfies it.
This is the single highest-value section for review, so be specific.
-->

| Acceptance criterion | Satisfied by |
| -------------------- | ------------ |
|                      |              |

## Verification

<!-- Paste the actual output of the issue's Verification commands. Not "ran tests, passed". -->

```

```

## Checklist

- [ ] Scope matches the issue: nothing in "Out of Scope" was touched
- [ ] Every acceptance criterion has a corresponding test
- [ ] Every named test from "Required Tests" exists and passes
- [ ] Performance budget measured and met, or `n/a` in the issue
- [ ] No secrets, keys, tokens, or credentials in the diff or in test fixtures
- [ ] Public API changes are reflected in `docs/`
- [ ] No AI or assistant co-author trailers in any commit

## Risk tier

- [ ] **Tier 1** - auth, IAM, deploy, credentials, or codegen (requires security review plus human approval)
- [ ] **Tier 2** - normal application code
- [ ] **Tier 3** - docs or tests only

## Breaking changes

<!-- IR schema, database schema, or public API changes. State the migration path, or write "none". -->

none
