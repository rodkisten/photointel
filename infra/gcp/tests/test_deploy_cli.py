"""Offline contract tests for the root manual deployment entrypoint."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEPLOY = ROOT / "deploy.sh"


class DeployCliTests(unittest.TestCase):
    def test_shell_syntax(self) -> None:
        result = subprocess.run(["bash", "-n", str(DEPLOY)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_help_is_offline(self) -> None:
        result = subprocess.run(["bash", str(DEPLOY), "help"], cwd=ROOT, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("deploy all", result.stdout)

    def test_deploy_uses_shared_gcp_bridge(self) -> None:
        content = DEPLOY.read_text(encoding="utf-8")
        self.assertIn('python3 -m infra.gcp.cloud_cli --project "$PROJECT" -- "$@"', content)
        self.assertNotIn("gcloud config set project", content)
        self.assertNotIn("sys.path.insert(", content)
        self.assertIn("python3 -m infra.scripts.deploy_manage", content)
        self.assertIn("python3 -m infra.gcp.gcp_env", content)


if __name__ == "__main__":
    unittest.main()
