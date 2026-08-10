---
title: '[infra] Byte-identical output for identical input, enforced by golden tests'
labels: tier:1, size:m, area:infra, epic:8-codegen
---

### Epic

#9

### Context

Three things downstream assume that generating twice from the same IR produces the same bytes.

The artifact rows from #27 store `content_sha256` per generated file, and the deploy path uploads a
source bundle keyed by its hash so it can claim the build ran on exactly the code we recorded. If
generation is not deterministic, that claim is decoration: the hash proves only which of many possible
outputs happened to be produced that afternoon.

`pulumi up --refresh` on an unchanged architecture must report no changes. If a regenerated program
differs in a way Pulumi can see - a reordered resource declaration that changes an autonamed logical
name, a re-serialised policy document - the second deploy replaces resources that did not need
replacing. That is downtime and a bill, caused by nothing.

And review depends on it. When an emitter changes, the interesting question is what the generated code
now looks like. A golden diff answers that in the pull request. A golden diff that is noisy because
every run shuffles imports answers nothing and gets deleted within a month.

Determinism does not happen by choosing to want it, because Python offers several ways to lose it by
accident. `set` iteration order for strings varies with `PYTHONHASHSEED`, which is randomised by
default, so `for name in imports` produces a different order in every process. `os.listdir` returns
entries in filesystem order. `datetime.now()` and `uuid4()` are non-deterministic by definition. Each
of these has to be removed by construction and then kept out by a test, not by a code review habit.

Spec: `docs/DELIVERY.md`

### Contract

Every source of non-determinism and its removal:

| Source                                         | Removal                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `set` iteration order under a random hash seed | Sets are collection buffers only. Emission always goes through `sorted()`, asserted by test                           |
| IR property and resource key order             | Emitters read named properties explicitly; resources are emitted in dependency order with ties broken by `logical_id` |
| JSON policy document key order                 | `json.dumps(doc, sort_keys=True, indent=2, separators=(",", ": "))` in one shared helper                              |
| `datetime.now()`, `time.time()`                | Banned in the codegen package. The only time value emitted is `expires_at`, taken from the input                      |
| `uuid4()`, `random`, `secrets`, `os.urandom`   | Banned. Unique physical names use `physical_suffix()`, a truncated sha256 of experiment and logical id                |
| Pulumi autonaming's random suffix              | Left alone: it is a property of the deployed resource, not of the emitted text                                        |
| `os.listdir` over the template directory       | Templates are read by explicit name through `importlib.resources`                                                     |
| Float repr differences                         | `render_number()` accepts `int` and `Decimal` only, and rejects `float`                                               |
| Host leakage: cwd, hostname, username          | Banned; asserted by scanning emitted output for the running machine's values                                          |
| Line endings and trailing whitespace           | Files joined with `"\n"`, written with `newline="\n"`, exactly one trailing newline                                   |
| Tool and generator version drift               | `generator_version` is emitted in the docstring, so a deliberate change shows as a golden diff                        |

```python
# services/brain/src/brain/codegen/determinism.py
BANNED_CALLS: frozenset[str] = frozenset({
    "datetime.now", "datetime.utcnow", "time.time", "time.monotonic",
    "uuid.uuid1", "uuid.uuid4", "random.random", "random.choice", "os.urandom",
    "secrets.token_hex", "secrets.token_urlsafe", "os.listdir", "socket.gethostname",
    "getpass.getuser", "tempfile.mktemp",
})


def banned_call_sites(package_root: Path) -> tuple[tuple[str, int, str], ...]:
    """Walk every module's ast under package_root. Returns (path, line, dotted name)."""


def render_json(document: Mapping[str, object]) -> str:
    """Canonical JSON for embedded policy documents: sorted keys, two-space indent."""


def render_number(value: int | Decimal) -> str:
    """Raises TypeError on float, bool, and non-finite values."""
```

Golden layout, one directory per case:

```
services/brain/tests/codegen/golden/
  minimal-lambda/{ir.json,expected/{Pulumi.yaml,__main__.py,resources.py,...}}
  http-api-lambda-dynamodb/{ir.json,expected/...}
  queue-with-dead-letter/{ir.json,expected/...}
  every-supported-type/{ir.json,expected/...}
```

The comparison is byte-for-byte over the full file set: a missing file, an extra file, and a changed
file are all failures, and the assertion message is a unified diff so a reviewer can read what moved.
`UPDATE_GOLDEN=1 uv run --directory services/brain pytest tests/codegen/test_golden.py` rewrites the
expectations; CI never sets it, and a separate test asserts that rewriting would produce no change, so
a stale golden file cannot pass by being ignored.

Two tests go beyond replaying a fixture:

- **Cross-process.** Generation runs in two subprocesses, one with `PYTHONHASHSEED=0` and one with
  `PYTHONHASHSEED=random`, and every file's sha256 must match. This is the only test that catches
  set-iteration order, because a single process with one seed is self-consistent.
- **Input shuffling.** The same IR is generated with its `resources` array reversed and its property
  dictionaries rebuilt in a different insertion order; output must be identical.

### Files

- CREATE `services/brain/src/brain/codegen/determinism.py`
- CREATE `services/brain/tests/codegen/test_determinism.py`
- CREATE `services/brain/tests/codegen/test_golden.py`
- CREATE `services/brain/tests/codegen/golden/minimal-lambda/ir.json`
- CREATE `services/brain/tests/codegen/golden/http-api-lambda-dynamodb/ir.json`
- CREATE `services/brain/tests/codegen/golden/queue-with-dead-letter/ir.json`
- CREATE `services/brain/tests/codegen/golden/every-supported-type/ir.json`
- CREATE `services/brain/tests/codegen/golden/README.md` - how to regenerate and what to check in a
  golden diff
- MODIFY `services/brain/src/brain/codegen/emit.py` - route imports and exports through `sorted()`
  and policy documents through `render_json`
- MODIFY `services/brain/src/brain/codegen/scaffold.py` - read templates by explicit name

Expected output files under each `golden/<case>/expected/` directory are created by running the
generator once and reviewing the result, so they are not enumerated here.

### Acceptance Criteria

- [ ] Generating a case twice in one process produces identical bytes for every file
- [ ] Generating in two processes with different `PYTHONHASHSEED` values produces identical bytes
- [ ] Reversing the IR's `resources` array does not change the output
- [ ] Rebuilding the IR's property dictionaries in a different key order does not change the output
- [ ] `banned_call_sites` reports zero results for the codegen package
- [ ] `render_number` raises `TypeError` for a `float` and for `True`
- [ ] Every emitted file ends with exactly one newline and contains no trailing whitespace
- [ ] No emitted file contains the generating machine's hostname, username, or working directory
- [ ] A stale golden file fails the suite rather than being silently regenerated
- [ ] `UPDATE_GOLDEN=1` rewrites the expectations and a following run passes with no diff

### Required Tests

- `generating twice in one process produces identical bytes`
- `generating under a different hash seed produces identical bytes`
- `reversing the resource array does not change the output`
- `reordering property keys does not change the output`
- `codegen package contains no banned nondeterministic calls`
- `render number rejects a float`
- `render json sorts keys regardless of input order`
- `every emitted file ends with a single newline`
- `no emitted file leaks the host name or working directory`
- `a stale golden expectation fails the suite`

### Performance Budget

The golden suite completes in under 10 seconds, and the cross-process determinism test in under 5,
measured with `pytest --durations=10`. The `every-supported-type` case stays under 400 lines of
expected output so a golden diff remains reviewable by a person.

### Out of Scope

- Do not add a rule to `scripts/ci/check-forbidden-patterns.mjs`; the guard is an AST walk over the
  whole codegen package, and that gate only inspects added lines
- Do not implement the deterministic source zip for CodeBuild here; it is defined in
  `docs/issues/epic-9-deploy/030-codebuild-deploy-with-log-stream.md` as fixed mtimes, sorted entries,
  and mode 0644
- Do not make the deployed resources' physical names deterministic; Pulumi's random suffix is what
  keeps two experiments in one account from colliding
- Do not snapshot the validation report as a golden file; tool versions change and would churn it
- Do not add golden tests for `packages/core/src/codegen/pulumi.ts`

### Dependencies

Blocked by #3, and by `docs/issues/epic-8-codegen/010-pulumi-python-emitter.md`,
`docs/issues/epic-8-codegen/020-project-scaffold-and-s3-state.md`, and
`docs/issues/epic-8-codegen/030-generated-code-validation.md`.

### Verification

```bash
uv run --directory services/brain pytest tests/codegen/test_golden.py -v
uv run --directory services/brain pytest tests/codegen/test_determinism.py -v
PYTHONHASHSEED=random uv run --directory services/brain pytest tests/codegen
uv run --directory services/brain pytest --durations=10
uv run --directory services/brain ruff check
uv run --directory services/brain mypy
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:m - 200 to 600 lines
