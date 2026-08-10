---
title: '[brain] Citation verifier that rejects unsupported claims'
labels: tier:2, size:m, area:brain, epic:6-brain
---

### Epic

#7

### Context

`040-appprofile-agent-with-citations.md` guarantees that every finding points at a span the tool
layer really returned. It does not guarantee that the span says what the finding claims. Those are
different failures, and the second is the common one: a model asked to justify a conclusion will
happily attach the nearest plausible line number, and the citation then makes a wrong claim look
checked. A profile with confident, well-formatted, unsupported citations is worse than one with no
citations at all, because a reviewer stops reading at the line reference.

This issue re-reads each cited span at verification time and decides whether it supports the claim.
Most claims do not need a model to settle. "This component depends on `psycopg`" is true if
`psycopg` appears in the span; "this Dockerfile exposes 8080" is true if the `EXPOSE` line is there.
A literal check over the re-read text answers the majority of findings deterministically, for free,
and identically on every run. Only the claims that are genuinely a judgement -- that a module is a
background worker, that an SDK call implies an object store -- go to a model.

**A separate judge rather than self-review.** Asking the same agent, in the same run, whether it
believes itself produces agreement, not verification: the context that generated the claim is the
context being asked to doubt it. The judge is a fresh call with only the claim and the span, no
history, no repository access, and a boolean output. It also runs at the `fast` scale whatever the
user selected, because it is a check on one paragraph rather than a second analysis, and paying
`thorough` prices to grade a substring would be hard to defend.

**The verifier fails closed.** If the file changed, if the span is gone, if the judge budget is
exhausted before a claim is reached, the claim is unsupported. The result is that a finding without a
standing citation never reaches the user: list entries are dropped with a note, and a required field
with nothing left raises rather than serialising a profile that quietly lost half its content.
Verification applies to deterministic findings too. They will nearly always pass, but exempting them
would introduce a trust flag that decides whether to check, and a trust flag is the thing that later
gets set wrongly.

Spec: `packages/core/src/analysis/profile.ts`

### Contract

```python
# services/brain/src/brain/profile/verifier.py
Verdict = Literal["supported", "unsupported", "span_missing", "span_changed"]

MAX_CLAIMS_PER_JUDGE_CALL = 10
MAX_JUDGE_CALLS = 4


class Verification(BaseModel):
    verdict: Verdict
    checked_by: Literal["literal", "model", "budget-exhausted"]
    # Shown to the user next to the dropped finding, so it must read as English.
    reason: str


class VerifiedCited[T](Cited[T]):
    verification: Verification


class UnsupportedClaimError(ValueError):
    """A field the profile cannot omit has no citation that survived."""


async def verify_citation(
    claim: str, citation: Citation, reader: SpanReader
) -> Verification:
    """Re-read the span and decide. Returns `span_missing` when the path or
    range is gone and `span_changed` when the file SHA-256 differs from the one
    recorded at read time, so a moved line is never reported as a lie."""


async def verify_profile(
    profile: CitedAppProfile, reader: SpanReader, judge: Judge
) -> VerifiedAppProfile:
    """Verify every finding. Unsupported list entries are dropped and each one
    appended to `notes` with its reason. Raises UnsupportedClaimError when
    `containerisation` has no surviving citation."""
```

```python
# services/brain/src/brain/profile/judge.py
class Judge:
    async def supports(self, claims: Sequence[tuple[str, str]]) -> list[bool]:
        """(claim, span text) pairs to booleans, in order, in one call per
        batch of ten. No repository access and no conversation history."""
```

The literal path is a table keyed by what is being claimed, so a new finding type has to declare how
it is checked rather than defaulting to the model:

```python
# Every term must appear in the re-read span, case-insensitively, after
# normalising quotes and separators. A dependency named "aws-sdk" must not be
# satisfied by the words "aws sdk" in a comment.
LITERAL_TERMS: dict[str, Callable[[object], list[str]]] = {
    "dependency.name": lambda d: [d.name],
    "containerisation.exposed_port": lambda c: [f"EXPOSE {c.port}"],
    "component.manifest_path": lambda c: [Path(c.manifest_path).name],
}
```

`POST /profile` gains verification between the agent run and serialisation, so an unverified profile
has no route to the response.

### Files

- CREATE `services/brain/src/brain/profile/verifier.py`
- CREATE `services/brain/src/brain/profile/judge.py`
- MODIFY `services/brain/src/brain/profile/models.py` - add `Verification` and `VerifiedCited`
- MODIFY `services/brain/src/brain/routes/profile.py` - verify before serialising, and map `UnsupportedClaimError` to 422
- CREATE `services/brain/tests/test_verifier.py`
- CREATE `services/brain/tests/test_judge.py`
- MODIFY `services/brain/tests/fixtures/profile/expected_profile.json` - add verification results

### Acceptance Criteria

- [ ] A dependency whose name does not appear in the re-read span is dropped and its reason recorded in `notes`
- [ ] A citation whose file SHA-256 no longer matches is `span_changed`, distinct from `unsupported`
- [ ] A citation whose path or line range no longer exists is `span_missing`, and is not sent to the judge
- [ ] A claim settled by the literal check never reaches the judge
- [ ] The judge is called with the claim and the span only, with no repository tools and no prior messages
- [ ] The judge runs at the `fast` reasoning scale regardless of the user's setting
- [ ] Claims left over when the judge budget is exhausted are `unsupported`, not `supported`
- [ ] A profile whose `containerisation` finding fails verification raises rather than serialising a partial object
- [ ] Deterministic findings are verified on the same path as agent findings, with no exemption flag
- [ ] The response contains no finding whose verdict is anything other than `supported`

### Required Tests

- `test_drops_a_dependency_absent_from_its_own_span`
- `test_reports_span_changed_when_the_file_hash_differs`
- `test_reports_span_missing_when_the_range_no_longer_exists`
- `test_literal_match_never_calls_the_judge`
- `test_literal_match_is_not_satisfied_by_a_near_miss`
- `test_judge_receives_no_repository_access`
- `test_unjudged_claims_are_treated_as_unsupported`
- `test_missing_containerisation_citation_raises_rather_than_omitting`
- `test_verifies_deterministic_findings_on_the_same_path`

### Performance Budget

Verification adds no more than 15% to the wall clock of a profile run on the 120-file fixture
repository, measured by the integration test against the same fixture
`040-appprofile-agent-with-citations.md` uses. At least 80% of findings are settled by the literal
check, asserted from the counts the verifier returns.

### Out of Scope

- Do not change how the agent produces findings or how the tools record reads
- Do not re-run the agent when a claim is rejected; the single repair round belongs to 040
- Do not add a UI for reviewing dropped findings
- Do not touch `packages/core/src/analysis/architecture.ts`, which consumes the profile downstream
- Do not cache judge verdicts here; `060-token-budget-and-cache.md` owns caching

### Dependencies

Blocked by #25, and by the agent in
`docs/issues/epic-6-brain/040-appprofile-agent-with-citations.md`.

### Verification

```bash
uv run --directory services/brain ruff check .
uv run --directory services/brain mypy src
uv run --directory services/brain pytest tests/test_verifier.py tests/test_judge.py -v
pnpm db:migrate && uv run --directory services/brain pytest -m integration
```

### Risk Tier

tier:2 - normal application code

### Size

size:m - 200 to 600 lines
