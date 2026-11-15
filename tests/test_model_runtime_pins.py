"""The independently deployed Modal image must use the audited dependency pins."""

import ast
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_modal_runtime_dependency_pins_match_the_audited_lockfile() -> None:
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    versions = {package["name"]: package["version"] for package in lock["package"]}
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
            assert versions[package] == version, package
