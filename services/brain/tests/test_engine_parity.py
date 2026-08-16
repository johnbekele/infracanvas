from __future__ import annotations

import importlib
import shutil
import subprocess
from typing import NoReturn, Protocol, cast

import pytest


class IcEngineModule(Protocol):
    def version(self) -> str: ...


def _import_ic_engine() -> IcEngineModule:
    try:
        module = importlib.import_module("ic_engine")
    except ModuleNotFoundError as exc:
        if exc.name == "ic_engine":
            pytest.skip("ic_engine extension is not built")
        raise

    return cast(IcEngineModule, module)


def _ic_engine_cli_version() -> str:
    cli = shutil.which("ic-engine")

    assert cli is not None, "`ic-engine` is not on PATH"

    completed = subprocess.run(  # noqa: S603 - parity requires executing the resolved CLI.
        [cli, "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    output = completed.stdout.strip()

    assert output, "`ic-engine --version` produced no output"

    return output.rsplit(maxsplit=1)[-1]


def test_python_module_reports_same_version_as_the_cli() -> None:
    """`ic_engine.version()` and `ic-engine --version` must agree."""
    ic_engine = _import_ic_engine()

    assert ic_engine.version() == _ic_engine_cli_version()


def test_skips_cleanly_when_the_extension_is_not_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_import(name: str) -> NoReturn:
        raise ModuleNotFoundError(f"No module named {name!r}", name=name)

    monkeypatch.setattr(importlib, "import_module", fail_import)

    with pytest.raises(pytest.skip.Exception):
        _import_ic_engine()
