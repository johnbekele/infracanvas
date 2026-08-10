---
title: '[infra] Validation gate that refuses to emit code it cannot check'
labels: tier:1, size:m, area:infra, epic:8-codegen
---

### Epic

#9

### Context

Generated code that does not compile wastes a CodeBuild run; generated code that compiles but opens a
bucket to the internet creates an incident in someone else's AWS account. The difference between
those two is not worth discovering after `pulumi up`, so nothing leaves the generator without being
checked, and a check that cannot run is treated as a failure rather than a pass.

The alternative was to validate at deploy time. Pulumi has CrossGuard, which runs policy packs during
`pulumi preview` inside the build. It was rejected for two reasons: it runs in the user's account
after we have already handed over code we never verified, and its failure surfaces as a build log
line minutes later rather than as a rejected request. Checking before emitting means a bad emitter
change is caught by the generator's own test suite, which is where a bug in our code belongs.

**What each tool is actually for.** ruff catches syntax and import errors in a second, which is the
cheapest possible way to notice that an emitter produced text rather than Python. mypy in strict mode
against the real `pulumi_aws` stubs is the only thing that catches a misnamed argument or a wrong
type - the failure mode the string-template generator in `packages/core` has no defence against at
all. checkov is narrower than it looks: it has frameworks for Terraform, CloudFormation, ARM and
others, but none for Pulumi Python, and `--framework pulumi` is a hard error. Running it and claiming
resource-level policy coverage would be a check that silently passes on everything. So checkov runs
with `--framework secrets`, where it is genuinely good, and the AWS misconfigurations it would have
caught for Terraform are asserted directly against the emitted AST by a small in-repo policy module.
Those rules live next to the emitters that must satisfy them, which is also the only place a new
resource type can forget them.

**Fails closed, deliberately.** mypy is useless without the Pulumi packages installed, so validation
needs a prepared virtualenv. When that environment is missing, the honest answer is that the code is
unvalidated, and unvalidated code is not deployable. Returning a pass with a warning would mean the
one configuration where the gate does nothing is also the configuration nobody notices.

Spec: `docs/DELIVERY.md`

### Contract

```python
# services/brain/src/brain/codegen/toolchain.py
@dataclass(frozen=True, slots=True)
class Toolchain:
    ruff: Path
    mypy: Path
    checkov: Path
    versions: Mapping[str, str]


class ToolchainUnavailableError(RuntimeError):
    """A required checker is missing. Validation fails; it does not degrade."""


def load_toolchain(settings: Settings) -> Toolchain:
    """Resolve executables under settings.generated_check_venv. Raises when any is absent."""


# services/brain/src/brain/codegen/validate.py
@dataclass(frozen=True, slots=True)
class Finding:
    tool: Literal["ruff", "mypy", "checkov", "invariant"]
    code: str
    path: str
    line: int | None
    message: str


@dataclass(frozen=True, slots=True)
class ValidationReport:
    ok: bool
    findings: tuple[Finding, ...]  # sorted by (path, line, code)
    tool_versions: Mapping[str, str]
    duration_ms: int


def validate_project(
    files: Sequence[GeneratedFile],
    toolchain: Toolchain,
    timeout_seconds: int = 60,
) -> ValidationReport:
    """Write files to a temporary directory, run every checker, and report."""
```

Each checker is invoked as an argument list, never through a shell:

```python
[str(toolchain.ruff), "check", "--no-cache", "--output-format", "json", str(workdir)]
[str(toolchain.mypy), "--strict", "--no-incremental", "--cache-dir", os.devnull, str(workdir)]
[str(toolchain.checkov), "-d", str(workdir), "--framework", "secrets",
 "--compact", "--quiet", "--output", "json"]
```

Ruff's `S603` and `S607` fire on these calls; they are silenced with a `# noqa` carrying the reason,
not by removing the rules from `pyproject.toml`.

```python
# services/brain/src/brain/codegen/policy.py
INVARIANTS: Mapping[str, str] = {
    "IC001": "S3 bucket has no BucketPublicAccessBlock with all four flags true",
    "IC002": "S3 bucket has no force_destroy=True, so destroy will strand it",
    "IC003": "Queue, table, or bucket is created without encryption enabled",
    "IC004": "IAM policy document contains a wildcard Action or Resource",
    "IC005": "Resource is created without the infracanvas:experiment-id tag",
    "IC006": "Database or cache resource sets publicly_accessible=True",
    "IC007": "Literal that looks like an AWS key, secret, or account id outside a tag value",
}


def check_invariants(program: str) -> tuple[Finding, ...]:
    """Walk the ast of resources.py. Structural, never regex over source text."""
```

The endpoint, which is how the deploy epic gets code:

```
POST /codegen/pulumi
{
  "experiment_id": "uuid", "region": "eu-west-1", "state_bucket": "infracanvas-state-...",
  "ir_version": "1.0.0", "ir": { ... }
}

200 -> { "files": [ { "path": "...", "content": "...", "sha256": "..." } ], "report": { ... } }
422 -> { "error": "validation_failed", "report": { ... } }
409 -> { "error": "unsupported_resource_type", "resource_type": "aws.ec2.instance" }
503 -> { "error": "toolchain_unavailable", "missing": ["mypy"] }
```

A 422 response body contains no `files` key at all. A caller cannot deploy rejected code by ignoring
a boolean.

### Files

- CREATE `services/brain/src/brain/codegen/toolchain.py`
- CREATE `services/brain/src/brain/codegen/validate.py`
- CREATE `services/brain/src/brain/codegen/policy.py`
- CREATE `services/brain/src/brain/routes/__init__.py`
- CREATE `services/brain/src/brain/routes/codegen.py`
- CREATE `services/brain/tests/codegen/test_validate.py`
- CREATE `services/brain/tests/codegen/test_policy.py`
- CREATE `services/brain/tests/codegen/test_codegen_route.py`
- CREATE `services/brain/tests/codegen/fixtures/request-valid.json`
- CREATE `services/brain/tests/codegen/fixtures/request-unsupported-type.json`
- CREATE `scripts/ci/prepare-generated-venv.sh` - build the checking virtualenv, printing its path
- MODIFY `services/brain/src/brain/app.py` - include the codegen router
- MODIFY `services/brain/src/brain/settings.py` - add `generated_check_venv` and
  `codegen_timeout_seconds`
- MODIFY `services/brain/pyproject.toml` - add `checkov` to the dev extra

### Acceptance Criteria

- [ ] A project whose program has a syntax error is rejected with a ruff finding carrying the line
      number
- [ ] A project passing a string where `pulumi_aws` expects an int is rejected with a mypy finding
- [ ] A hardcoded AWS access key id in the program is rejected with a checkov secrets finding
- [ ] A bucket emitted without a public access block is rejected with `IC001`
- [ ] An IAM policy document with `"Action": "*"` is rejected with `IC004`
- [ ] `validate_project` returns `ok: false` when the checking virtualenv is absent, and the route
      answers 503 rather than 200
- [ ] A checker that exceeds its timeout is a failure, not a pass, and the report names the tool
- [ ] `POST /codegen/pulumi` with a valid IR returns files whose `sha256` matches their content
- [ ] `POST /codegen/pulumi` returns 422 with no `files` key when any finding is present
- [ ] `report.tool_versions` records the resolved version of every checker that ran

### Required Tests

- `rejects a program with a syntax error`
- `rejects a program with a type error against the pulumi stubs`
- `rejects a hardcoded access key id`
- `rejects a bucket with no public access block`
- `rejects a wildcard iam action`
- `rejects a resource missing the experiment tag`
- `fails closed when the checking virtualenv is missing`
- `treats a checker timeout as a failure`
- `route returns files and a passing report for a valid ir`
- `route returns no files alongside a failing report`

### Performance Budget

Validating a 200-resource project completes in under 25 seconds on the CI runner, recorded in
`report.duration_ms`: ruff under 1s, checkov under 5s, mypy the remainder. Per-checker timeout is 60
seconds. This runs inside a queue job rather than a web request, so the budget is about a deploy
feeling responsive, not about an HTTP timeout.

### Out of Scope

- Do not pass `--framework pulumi` to checkov; it is not a valid framework and errors out
- Do not add a CrossGuard policy pack to the generated project
- Do not add a flag, header, or setting that skips validation, including for local development
- Do not run `pulumi preview` here; that needs AWS credentials and belongs to the deploy epic
- Do not lint the brain's own source with these calls; `uv run --directory services/brain ruff check`
  already covers it

### Dependencies

Blocked by #3, and by `docs/issues/epic-8-codegen/010-pulumi-python-emitter.md` and
`docs/issues/epic-8-codegen/020-project-scaffold-and-s3-state.md`.

### Verification

```bash
bash scripts/ci/prepare-generated-venv.sh
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
uv run --directory services/brain pytest tests/codegen -v
curl -s -X POST localhost:8000/codegen/pulumi -H 'content-type: application/json' \
  -d @services/brain/tests/codegen/fixtures/request-valid.json | head -40
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
