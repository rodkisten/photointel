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
        for value in ("build", "jobs-deploy", "migrate", "deploy", "scheduler", "cleanup"):
            self.assertIn(f"          - {value}\n", self.workflow)
        self.assertIn("        default: all", self.workflow)

    def test_all_stages_keep_expected_order(self) -> None:
        expected = (
            "database_gate", "preflight", "image_cache", "build_image",
            "verify_image", "deploy_jobs", "migrate_database", "deploy_api",
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
        self.assertIn("run: bash infra/gcp/release.sh build", self.stage("build_image"))
        self.assertIn("run: bash infra/gcp/release.sh verify", self.stage("verify_image"))
        self.assertLess(self.stages["build_image"], self.stages["verify_image"])
        self.assertLess(self.stages["verify_image"], self.stages["deploy_jobs"])

    def test_api_publication_requires_explicit_operator_readiness(self) -> None:
        self.assertIn("        default: false", self.workflow)
        self.assertIn("inputs.database_ready", self.stage("database_gate"))
        self.assertIn("DATABASE_READY", self.stage("database_gate"))
        self.assertIn("run: bash infra/gcp/release.sh gate", self.stage("database_gate"))
        guard = (ROOT / "infra/gcp/release.sh").read_text(encoding="utf-8")
        self.assertIn("DATABASE_READY", guard)
        self.assertIn("return 1", guard)
        self.assertIn("inputs.action == 'deploy'", self.stage("database_gate"))
        self.assertIn("inputs.action == 'all'", self.stage("database_gate"))
        self.assertNotIn("manage.py migrate", self.workflow, "No automatic database migrations")
        self.assertLess(self.stages["database_gate"], self.stages["build_image"])

    def test_migration_is_opt_in_and_requires_database_safety_evidence(self) -> None:
        migrate = self.stage("migrate_database")
        self.assertIn("inputs.action == 'migrate'", migrate)
        self.assertNotIn("inputs.action == 'all'", migrate)
        self.assertIn("run: bash infra/gcp/release.sh migrate", migrate)
        self.assertIn("inputs.migration_mode", migrate)
        self.assertIn("inputs.migration_database", migrate)
        self.assertIn("inputs.migration_backup_prefix", migrate)
        self.assertNotIn("migration_release_sha", self.workflow)
        self.assertNotIn("initial_empty_database:", self.workflow)
        self.assertIn("id: migrate_database", migrate)
        self.assertIn("steps.migrate_database.outcome", self.workflow)
        self.assertIn("steps.notify_live_start.outputs.activity_id", self.workflow)
        self.assertIn("        default: plan", self.workflow)
        self.assertIn("        default: unselected", self.workflow)
        self.assertIn("inputs.migration_mode == 'plan'", self.workflow)
        self.assertTrue((ROOT / "infra/gcp/migrate_workflow.py").is_file())

    def test_migration_diagnose_mode_and_failure_logs(self) -> None:
        self.assertIn("          - diagnose", self.workflow)
        self.assertIn("inputs.migration_mode == 'diagnose'", self.workflow)
        assert "migrate_diagnostics" in self.stages
        diagnostic = self.stage("migrate_diagnostics")
        self.assertIn("run: bash infra/gcp/release.sh diagnose-migration", diagnostic)
        self.assertIn("steps.migrate_database.outcome == 'failure'", diagnostic)
        self.assertIn("inputs.migration_mode == 'apply'", diagnostic)
        self.assertIn("continue-on-error: true", diagnostic)
        self.assertLess(self.stages["migrate_database"], self.stages["migrate_diagnostics"])
        self.assertLess(self.stages["migrate_diagnostics"], self.stages["deploy_api"])
        self.assertIn("steps.migrate_diagnostics.outcome", self.workflow)
        self.assertTrue((ROOT / "infra/gcp/diagnose_migration.py").is_file())
        shell = (ROOT / "infra/gcp/release.sh").read_text(encoding="utf-8")
        self.assertIn("MIGRATION_STARTED_UTC=", shell)
        self.assertIn("diagnose_migration.py", shell)

    def test_workflow_has_no_embedded_bash_or_python_scripts(self) -> None:
        self.assertNotIn("run: |", self.workflow)
        self.assertNotIn("python3 -c", self.workflow)
        self.assertNotIn("python3 - <<", self.workflow)
        self.assertNotIn("gcloud artifacts docker images list", self.workflow)
        for stage, command in {
            "database_gate": "gate",
            "preflight": "preflight",
            "image_cache": "cache",
            "verify_image": "verify",
            "build_image": "build",
            "deploy_jobs": "jobs-deploy",
            "migrate_database": "migrate",
            "deploy_api": "deploy",
            "deploy_scheduler": "scheduler",
            "pause_scheduler": "cleanup",
        }.items():
            self.assertIn(f"run: bash infra/gcp/release.sh {command}", self.stage(stage))
        self.assertTrue((ROOT / "infra/gcp/release.sh").is_file())
        self.assertTrue((ROOT / "infra/gcp/release_image.py").is_file())

    def test_each_operation_is_separate_and_cleanup_is_always_invoked(self) -> None:
        commands = {
            "deploy_jobs": "jobs-deploy",
            "deploy_api": "deploy",
            "deploy_scheduler": "scheduler",
            "pause_scheduler": "cleanup",
        }
        for stage, operation in commands.items():
            self.assertIn(f"run: bash infra/gcp/release.sh {operation}", self.stage(stage))
        self.assertIn("if: always() && steps.checkout.outcome == 'success'", self.workflow)
        self.assertIn("uses: ./.github/actions/gcp-config", self.workflow)


if __name__ == "__main__":
    unittest.main()
