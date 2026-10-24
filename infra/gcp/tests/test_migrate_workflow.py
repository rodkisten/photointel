"""Offline guardrail tests for the manual migration GitHub Actions adapter."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra/gcp"))
SPEC = importlib.util.spec_from_file_location(
    "gcp_migrate_workflow", ROOT / "infra/gcp/migrate_workflow.py"
)
assert SPEC and SPEC.loader
migrate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migrate)

PROJECT = "photointel"
SHA = "a" * 40
IMAGE = f"us-central1-docker.pkg.dev/{PROJECT}/{PROJECT}/api:{SHA}"
PREFIX = f"gs://{PROJECT}-photointel-build-source/migration-backups/snapshot-2026"


def fake_job(image: str = IMAGE, *, retries: int = 0, sa: str | None = None):
    return {
        "kind": "Job",
        "spec": {
            "template": {
                "spec": {
                    "template": {
                        "spec": {
                            "containers": [{
                                "image": image,
                                "args": ["-m", "photointel.services.task_runner", "migrate"],
                            }],
                            "serviceAccountName": sa or f"photointel-migrate@{PROJECT}.iam.gserviceaccount.com",
                            "maxRetries": retries,
                        }
                    }
                }
            }
        },
    }


class MigrationWorkflowTests(unittest.TestCase):
    def test_only_private_project_backup_objects_allowed(self):
        self.assertEqual(migrate.check_backup_prefix(PREFIX, PROJECT), PREFIX)
        for bad in (
            "https://example.com/manifest.enc",
            "gs://another-bucket/migration-backups/backup1",
            f"gs://{PROJECT}-photointel-build-source/source/backup",
            f"gs://{PROJECT}-photointel-build-source/migration-backups/../other",
            f"gs://{PROJECT}-photointel-build-source/migration-backups/a/b",
            "",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(migrate.MigrationWorkflowError):
                    migrate.check_backup_prefix(bad, PROJECT)

    def test_job_rejects_old_image_wrong_identity_retry_or_command(self):
        with patch.object(migrate, "run_gcloud", return_value=json.dumps(fake_job())):
            self.assertEqual(
                migrate.job_spec(IMAGE.rsplit(":", 1)[0], PROJECT, "us-central1"),
                SHA,
            )
            with self.assertRaisesRegex(migrate.MigrationWorkflowError, "repository image"):
                migrate.job_spec("us-central1-docker.pkg.dev/other/project/api", PROJECT, "us-central1")
        for payload in (
            fake_job(retries=1),
            fake_job(sa="someone-else@example.com"),
            {**fake_job(), "spec": {}},
        ):
            with patch.object(migrate, "run_gcloud", return_value=json.dumps(payload)):
                with self.assertRaises(migrate.MigrationWorkflowError):
                    migrate.job_spec(IMAGE.rsplit(":", 1)[0], PROJECT, "us-central1")

    def test_plan_does_not_execute_migration(self):
        config = {
            "project_id": PROJECT, "region": "us-central1",
            "release_git_sha": SHA, "image": IMAGE,
        }
        with tempfile.TemporaryDirectory() as directory:
            location = Path(directory) / "config.json"
            location.write_text(json.dumps(config), encoding="utf-8")
            with (
                patch.object(migrate, "validate", return_value=config),
                patch.object(migrate, "job_spec", return_value=SHA),
                patch.object(migrate, "apply_migration", side_effect=AssertionError("apply prohibited")),
            ):
                self.assertEqual(migrate.main([
                    "--mode", "plan", "--project", PROJECT, "--sha", SHA,
                    "--config", str(location),
                ]), 0)

    def test_apply_infers_sha_from_deployed_job(self):
        config = {"project_id": PROJECT, "region": "us-central1",
                  "release_git_sha": SHA, "image": IMAGE}
        with tempfile.TemporaryDirectory() as directory:
            location = Path(directory) / "config.json"
            location.write_text(json.dumps(config), encoding="utf-8")
            with (
                patch.object(migrate, "validate", return_value=config),
                patch.object(migrate, "job_spec", return_value=SHA) as lookup,
                patch.object(migrate, "apply_migration") as apply,
            ):
                args = ["--mode", "apply", "--project", PROJECT, "--sha", SHA,
                        "--database", "initial-empty", "--config", str(location)]
                self.assertEqual(migrate.main(args), 0)
                self.assertEqual(lookup.call_count, 2)
                apply.assert_called_once_with(PROJECT, "initial-empty", "")

    def test_initial_empty_selection_is_sufficient_attestation(self):
        with patch.object(migrate.subprocess, "run") as execute:
            with self.assertRaises(migrate.MigrationWorkflowError):
                migrate.apply_migration(PROJECT, "initial-empty", PREFIX)
            execute.assert_not_called()
            migrate.apply_migration(PROJECT, "initial-empty", "")
            command = execute.call_args.args[0]
            self.assertIn("--initial-empty-database", command)
            self.assertNotIn("--backup-directory", command)

    def test_existing_db_never_uses_empty_flag_or_skips_restore_receipt(self):
        with (
            patch.object(migrate, "run_gcloud") as cloud,
            patch.object(migrate, "verify_backup_receipt") as verify,
            patch.object(migrate.subprocess, "run") as execute,
        ):
            with self.assertRaises(migrate.MigrationWorkflowError):
                migrate.apply_migration(PROJECT, "existing-with-backup", True, PREFIX)
            with self.assertRaises(migrate.MigrationWorkflowError):
                migrate.apply_migration(PROJECT, "existing-with-backup", False, "")
            cloud.assert_not_called()
            verify.assert_not_called()
            execute.assert_not_called()

            # Mock private ciphertext downloads. The real receipt validator is
            # tested separately in manage.py's offline regression suite.
            def fake_download(args, project, *, capture=False):
                Path(args[-1]).write_bytes(b"fake encrypted ciphertext or receipt")
                return ""

            cloud.side_effect = fake_download
            migrate.apply_migration(PROJECT, "existing-with-backup", False, PREFIX)
            self.assertEqual(cloud.call_count, 3)
            verify.assert_called_once()
            command = execute.call_args.args[0]
            self.assertIn("--backup-directory", command)
            self.assertIn("--backup-receipt", command)
            self.assertNotIn("--initial-empty-database", command)

    def test_apply_with_unselected_database_fails_without_execution(self):
        with patch.object(migrate.subprocess, "run") as execute:
            with self.assertRaisesRegex(migrate.MigrationWorkflowError, "Select migration_database"):
                migrate.apply_migration(PROJECT, "unselected", False, "")
            execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
