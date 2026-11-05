"""Offline contracts for real infrastructure packages and installed CLI entrypoints.

No Google credentials, Cloud Build, network access or production mutations.
"""
from __future__ import annotations

import importlib
import os
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

from infra import repository_root

ROOT = Path(__file__).resolve().parents[3]
PACKAGED_SCRIPTS = (
    "infra/gcp/manage.py",
    "infra/gcp/gcp_env.py",
    "infra/gcp/config_sync.py",
    "infra/gcp/release_image.py",
    "infra/gcp/diagnose_startup.py",
    "infra/gcp/diagnose_api_connectivity.py",
    "infra/gcp/diagnose_migration.py",
    "infra/gcp/icloud_preflight.py",
    "infra/gcp/migrate_workflow.py",
    "infra/terminal/terminal.py",
    "infra/terminal/boot_logs.py",
    "infra/terminal/sync_startup.py",
    "infra/scripts/icloud_terminal.py",
    "infra/scripts/prepare_workflow_env.py",
    "infra/scripts/cloudflare_setup.py",
    "infra/scripts/deploy_manage.py",
)


class InfrastructurePackageTests(unittest.TestCase):
    def test_entrypoints_are_importable_and_distribution_includes_infra(self) -> None:
        config = tomllib.loads((ROOT / "pyproject.toml").read_text())
        entrypoints = config["project"]["scripts"]
        self.assertIn("infra", config["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"])
        for name in ("photointel-gcloud", "photointel-gcp",
                     "photointel-terminal", "photointel-vm-sync", "photointel-gcp-env"):
            with self.subTest(name=name):
                module_name, symbol = entrypoints[name].split(":", 1)
                module = importlib.import_module(module_name)
                self.assertTrue(callable(getattr(module, symbol)))

    def test_package_root_is_source_checkout_not_site_packages(self) -> None:
        self.assertEqual(repository_root(__file__), ROOT)
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"PHOTOINTEL_REPO_ROOT": str(ROOT)}):
                with patch("pathlib.Path.cwd", return_value=Path(directory)):
                    self.assertEqual(repository_root(__file__), ROOT)
            with patch.dict(os.environ, {"PHOTOINTEL_REPO_ROOT": directory}):
                with self.assertRaisesRegex(RuntimeError, "PHOTOINTEL_REPO_ROOT"):
                    repository_root(__file__)

    def test_no_mutation_of_sys_path_in_infrastructure_clients(self) -> None:
        for relative in PACKAGED_SCRIPTS:
            with self.subTest(path=relative):
                text = (ROOT / relative).read_text()
                self.assertNotIn("sys.path.insert(", text)
                self.assertNotIn("from cloud_cli import", text)
                self.assertNotIn("from manage import", text)

    def test_python_module_help_is_offline(self) -> None:
        for module in ("infra.gcp.manage", "infra.gcp.cloud_cli",
                       "infra.terminal.sync_startup", "infra.terminal.terminal"):
            with self.subTest(module=module):
                process = subprocess.run(
                    [sys.executable, "-m", module, "--help"],
                    cwd=ROOT, capture_output=True, text=True,
                    timeout=15, check=False,
                )
                self.assertEqual(process.returncode, 0, process.stderr[:300])

    def test_gcp_parser_is_single_module_not_a_duplicate(self) -> None:
        self.assertTrue((ROOT / "infra/gcp/gcp_env.py").is_file())
        self.assertFalse((ROOT / "infra/gcp/gcp-env.py").exists())


if __name__ == "__main__":
    unittest.main()
