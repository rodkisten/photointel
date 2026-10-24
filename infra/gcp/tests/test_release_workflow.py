"""Offline contract checks for the ordered and gated GCP release workflow."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_PATH = ROOT / ".github/workflows/gcp-deploy.yml"


class ReleaseWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
        cls.stages = {}
        for match in re.finditer(
            r"^      - name: .+\n        id: ([a-z_]+)\n",
            cls.workflow,
            flags=re.MULTILINE,
        ):
            cls.stages[match.group(1)] = match.start()

    def stage(self, stage_id: str) -> str:
        self.assertIn(stage_id, self.stages, f"Stage missing: {stage_id}")
        start = self.stages[stage_id]
        next_step = self.workflow.find("\n      - name:", start + 1)
        return self.workflow[start:next_step if next_step > start else None]

    def test_dropdown_supports_all_and_each_stage(self) -> None:
        self.assertIn("          - all\n", self.workflow)
        for value in ("build", "jobs-deploy", "deploy", "scheduler", "cleanup"):
            self.assertIn(f"          - {value}\n", self.workflow)
        self.assertIn("        default: all", self.workflow)

    def test_all_stages_keep_expected_order(self) -> None:
        expected = (
            "database_gate", "preflight", "image_cache", "build_image",
            "verify_image", "deploy_jobs", "deploy_api",
            "deploy_scheduler", "pause_scheduler",
        )
        positions = [self.stages.get(stage, -1) for stage in expected]
        self.assertTrue(all(position >= 0 for position in positions), positions)
        self.assertEqual(positions, sorted(positions))

    def test_all_mode_is_wired_to_build_jobs_api_and_scheduler(self) -> None:
        for stage in (
            "preflight", "image_cache", "build_image", "verify_image",
            "deploy_jobs", "deploy_api", "deploy_scheduler",
        ):
            self.assertIn("inputs.action == 'all'", self.stage(stage), stage)

    def test_build_is_reused_and_verified_before_jobs(self) -> None:
        self.assertIn("steps.image_cache.outputs.skip != 'true'", self.stage("build_image"))
        self.assertIn("python3 infra/gcp/manage.py build --apply", self.stage("build_image"))
        self.assertIn("gcloud artifacts docker images list", self.stage("verify_image"))
        self.assertLess(self.stages["build_image"], self.stages["verify_image"])
        self.assertLess(self.stages["verify_image"], self.stages["deploy_jobs"])

    def test_api_publication_requires_explicit_operator_readiness(self) -> None:
        self.assertIn("        default: false", self.workflow)
        self.assertIn("inputs.database_ready", self.stage("database_gate"))
        self.assertIn("DATABASE_READY", self.stage("database_gate"))
        self.assertIn("exit 1", self.stage("database_gate"))
        self.assertIn("inputs.action == 'deploy'", self.stage("database_gate"))
        self.assertIn("inputs.action == 'all'", self.stage("database_gate"))
        self.assertNotIn("manage.py migrate", self.workflow, "No automatic database migrations")
        self.assertLess(self.stages["database_gate"], self.stages["build_image"])

    def test_each_operation_is_separate_and_cleanup_is_always_invoked(self) -> None:
        commands = {
            "deploy_jobs": "jobs-deploy",
            "deploy_api": "deploy",
            "deploy_scheduler": "scheduler",
            "pause_scheduler": "cleanup",
        }
        for stage, operation in commands.items():
            self.assertIn(f"python3 infra/gcp/manage.py {operation} --apply", self.stage(stage))
        self.assertIn("if: always() && steps.checkout.outcome == 'success'", self.workflow)
        self.assertIn("uses: ./.github/actions/gcp-config", self.workflow)


if __name__ == "__main__":
    unittest.main()
