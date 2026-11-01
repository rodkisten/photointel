"""Contract checks for path-scoped automatic workflows and opt-in operations."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / ".github" / "workflows"


class WorkflowPushSafetyTests(unittest.TestCase):
    def test_every_workflow_has_main_paths_and_manual_dispatch(self):
        paths = sorted(WORKFLOWS.glob("*.yml"))
        self.assertGreaterEqual(len(paths), 21)
        for path in paths:
            source = path.read_text(encoding="utf-8")
            with self.subTest(workflow=path.name):
                self.assertIn("  workflow_dispatch:", source)
                self.assertRegex(
                    source, r"(?m)^  push:\n    branches: \[main\]\n    paths:"
                )
                self.assertNotIn("    paths-ignore:", source.split("  push:", 1)[1].split("  workflow_dispatch:", 1)[0].split("  pull_request:", 1)[0])

    def test_sensitive_actions_remain_manually_authorized(self):
        for name, job in (
            ("gcp-bootstrap.yml", "bootstrap"),
            ("gcp-deploy.yml", "deploy"),
            ("gcp-migrate.yml", "migrate"),
            ("gcp-terminal.yml", "terminal"),
            ("ssh.yml", "development"),
            ("zip.yml", "apply-zip"),
        ):
            source = (WORKFLOWS / name).read_text(encoding="utf-8")
            with self.subTest(workflow=name):
                block = source.split(f"  {job}:\n", 1)[1].split("\n  ", 1)[0]
                self.assertIn("github.event_name == 'workflow_dispatch'", block)
                self.assertIn("  push-check:", source)

    def test_cloud_production_operations_have_separate_push_concurrency(self):
        for name in ("gcp-bootstrap.yml", "gcp-deploy.yml", "gcp-migrate.yml"):
            source = (WORKFLOWS / name).read_text(encoding="utf-8")
            with self.subTest(workflow=name):
                self.assertIn("github.event_name == 'push'", source)
                self.assertIn("|| 'photointel-gcp-production'", source)
                self.assertIn("if: github.event_name == 'push'", source)

    def test_cleanup_never_deletes_on_push(self):
        source = (WORKFLOWS / "artifact-cleanup.yml").read_text(encoding="utf-8")
        guard = source.index("context.eventName !== 'workflow_dispatch'")
        deletion = source.index("github.rest.actions.deleteArtifact")
        self.assertLess(guard, deletion)


if __name__ == "__main__":
    unittest.main()
