---
title: '[ci] Assert engine version parity across the Python boundary'
labels: tier:3, size:s, area:ci, epic:1-data
---

### Epic

#2

### Context

The engine is reachable two ways: the `ic-engine` binary and the `ic_engine` Python extension module.
Both report a version, and they must report the same one. When a user files a bug against the CLI
and a maintainer reproduces it through the Python path, a silent version skew turns that into an
afternoon of chasing a difference that is not in the code.

The two versions come from the same `env!("CARGO_PKG_VERSION")` today, so they cannot currently
disagree. They will be able to as soon as the wheel is built and cached separately from the binary,
which is exactly when nobody will be looking.

This was originally listed in #31 as `test_python_module_reports_same_version`. It could not be done
there: `services/brain` did not exist on `main`, and building the wheel then installing it into the
brain's environment is a CI change that belongs with the Python package rather than with the crate.
Parity was verified by hand on that pull request; this issue automates it.

Spec: `crates/ic-engine/README.md`

### Contract

```python
# services/brain/tests/test_engine_parity.py
def test_python_module_reports_same_version_as_the_cli() -> None:
    """`ic_engine.version()` and `ic-engine --version` must agree."""
```

The test skips rather than fails when `ic_engine` is not importable, so a clone that has not built
the wheel still gets a green unit run. Gate 3 builds the wheel first, so in CI it runs rather than
skips.

`services/brain/pyproject.toml` gains an optional dependency group that installs the locally built
wheel, and `.github/workflows/gate-test.yml` builds it with maturin before the Python suite.

### Files

- CREATE `services/brain/tests/test_engine_parity.py`
- MODIFY `.github/workflows/gate-test.yml` - build the wheel with maturin before `pytest`
- MODIFY `services/brain/README.md` - document how to build the engine locally for this test

### Acceptance Criteria

- [ ] The test compares `ic_engine.version()` against the `ic-engine --version` output and fails when they differ
- [ ] The test skips, rather than fails, when `ic_engine` is not importable
- [ ] Gate 3 builds the wheel so the test runs rather than skips in CI
- [ ] A deliberately mismatched version causes the test to fail, verified once by hand
- [ ] `pnpm test` and the Python unit suite still pass on a clone with no Rust toolchain

### Required Tests

- `test_python_module_reports_same_version_as_the_cli`
- `test_skips_cleanly_when_the_extension_is_not_built` - asserted by running the suite in an
  environment without the wheel and observing a skip rather than an error

### Performance Budget

Building the wheel adds under 90 seconds to Gate 3 from a warm cargo cache.

### Out of Scope

- Do not publish the wheel to any registry
- Do not add the engine as a runtime dependency of the brain; this issue only wires it for tests
- Do not change how either entry point derives its version

### Dependencies

Blocked by #30 and #31.

### Verification

```bash
maturin build -m crates/ic-engine/Cargo.toml --release
uv pip install --directory services/brain target/wheels/ic_engine-*.whl
uv run --directory services/brain pytest tests/test_engine_parity.py -v
```

### Risk Tier

tier:3 - docs or tests only

### Size

size:s - under 200 lines
