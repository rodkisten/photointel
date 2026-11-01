"""Contract tests for the dedicated opt-in Neon migration Actions workflow.

Offline checks only. Do not access Google Cloud, Neon, or Secret Manager.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github/workflows/gcp-migrate.yml"
DEPLOY = ROOT / ".github/workflows/gcp-deploy.yml"


class StandaloneMigrationWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.migrate = WORKFLOW.read_text(encoding="utf-8")
        cls.deploy = DEPLOY.read_text(encoding="utf-8")

    def test_only_manual_migrations_and_main_branch(self):
        self.assertIn("  workflow_dispatch:", self.migrate)
        self.assertIn("  push:", self.migrate)
        self.assertIn("    branches: [main]", self.migrate)
        self.assertIn("  push-check:", self.migrate)
        self.assertIn("if: github.event_name == 'push'", self.migrate)
        self.assertIn("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'", self.migrate)
        # Pushes may run offline checks but must never execute production migrations.
        push_job = self.migrate.split("  push-check:", 1)[1].split("  migrate:", 1)[0]
        self.assertNotIn("release.sh migrate", push_job)
        self.assertNotIn("gcloud", push_job)
        self.assertNotIn("id-token: write", push_job)
        self.assertNotIn("  pull_request:", self.migrate)
        self.assertIn("github.ref == 'refs/heads/main'", self.migrate)
        self.assertIn("name: \"🗃️ Migrate Neon\"", self.migrate)
        self.assertIn("environment: production", self.migrate)

    def test_same_migration_options_as_existing_deploy(self):
        for text in (
            "migration_mode:", "migration_database:", "migration_backup_prefix:",
            "          - plan", "          - apply", "          - diagnose",
            "          - unselected", "          - initial-empty",
            "          - existing-with-backup",
            "default: plan", "default: unselected",
            "confirm_project:", "default: photointel",
        ):
            with self.subTest(item=text):
                self.assertIn(text, self.migrate)
                self.assertIn(text, self.deploy)

    def test_apply_is_explicitly_authorized_and_never_the_default(self):
        self.assertIn("inputs.migration_mode == 'apply' && inputs.authorize_charges == true", self.migrate)
        self.assertIn("inputs.migration_mode == 'plan'", self.migrate)
        self.assertIn("inputs.migration_mode == 'diagnose'", self.migrate)
        self.assertIn("default: false", self.migrate)

    def test_same_exact_runner_and_inputs_as_existing_deploy(self):
        for line in (
            "run: bash infra/gcp/release.sh migrate",
            "CONFIRM_PROJECT: ${{ inputs.confirm_project }}",
            "RELEASE_SHA: ${{ github.sha }}",
            "MIGRATION_MODE: ${{ inputs.migration_mode }}",
            "MIGRATION_DATABASE: ${{ inputs.migration_database }}",
            "MIGRATION_BACKUP_PREFIX: ${{ inputs.migration_backup_prefix }}",
            "config-env: ${{ vars.GCP_CONFIG_ENV }}",
            "release-sha: ${{ github.sha }}",
        ):
            with self.subTest(item=line):
                self.assertIn(line, self.migrate)
                self.assertIn(line, self.deploy)
        self.assertEqual(self.migrate.count("run: bash infra/gcp/release.sh migrate"), 1)
        self.assertNotIn("run: bash infra/gcp/release.sh deploy", self.migrate)
        self.assertNotIn("run: bash infra/gcp/release.sh build", self.migrate)
        self.assertNotIn("run: bash infra/gcp/release.sh jobs-deploy", self.migrate)
        self.assertNotIn("jobs execute", self.migrate)

    def test_auth_notifications_cleanup_and_shared_production_lock(self):
        for expected in (
            "|| 'photointel-gcp-production'",
            "cancel-in-progress: false",
            "contents: read",
            "id-token: write",
            "actions: read",
            "persist-credentials: false",
            "uses: google-github-actions/auth@v2",
            "uses: google-github-actions/setup-gcloud@v2",
            "uses: ./.github/actions/gcp-config",
            "uses: ./.github/actions/notify",
            "steps.notify_live_start.outputs.activity_id",
            "steps.migrate_database.outcome",
            "if: always() && steps.checkout.outcome == 'success'",
            "mode: cleanup",
            "outcome: ${{ job.status }}",
        ):
            with self.subTest(item=expected):
                self.assertIn(expected, self.migrate)
        self.assertEqual(self.migrate.count("uses: ./.github/actions/gcp-config"), 2)
        self.assertLess(self.migrate.index("mode: prepare"), self.migrate.index("mode: cleanup"))

    def test_non_sensitive_workflow_has_no_embedded_migration_code_or_secrets(self):
        self.assertNotIn("run: |", self.migrate)
        self.assertNotIn("alembic upgrade", self.migrate)
        self.assertNotIn("MIGRATION_DATABASE_URL:", self.migrate)
        self.assertNotIn("gcloud secrets versions access", self.migrate)
        self.assertTrue((ROOT / "infra/gcp/migrate_workflow.py").is_file())


if __name__ == "__main__":
    unittest.main()
