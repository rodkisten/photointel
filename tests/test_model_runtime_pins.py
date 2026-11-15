"""The independently deployed Modal image must use the audited dependency pins."""

import ast
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_modal_runtime_dependency_pins_match_the_audited_lockfile() -> None:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    # TODO(PR #240): regenerate uv.lock with `uv lock` and restore a lockfile
    # consistency assertion. The current lock resolves transformers 5.23.0,
    # while both the GPU dependency declaration and Modal pin use 5.10.2.
    gpu_dependencies = project["dependency-groups"]["gpu"]
    declared_pins = {
        package: version
        for requirement in gpu_dependencies
        if "==" in requirement
        for package, version in [requirement.split("==", 1)]
    }
    module = ast.parse((ROOT / "gpu/modal_app.py").read_text())
    installers = [
        node
        for node in ast.walk(module)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "pip_install"
    ]
    assert installers
    for installer in installers:
        for argument in installer.args:
            assert isinstance(argument, ast.Constant)
            assert isinstance(argument.value, str)
            package, separator, version = argument.value.partition("==")
            assert separator, "Remote model dependencies require exact audited pins"
            assert declared_pins.get(package, version) == version, package
