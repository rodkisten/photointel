"""Offline direct-to-Neon migration safety tests. No real network or SQL."""

from __future__ import annotations

import importlib.util
import json
import os
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
sys.modules[SPEC.name] = migrate
SPEC.loader.exec_module(migrate)

PROJECT = "photointel"
PREFIX = f"gs://{PROJECT}-photointel-build-source/migration-backups/snapshot-2026"
CONFIG = {
    "project_id": PROJECT,
    "secrets": {
        "MIGRATION_DATABASE_URL": {
            "name": "photointel-migration-database-url",
            "version": "1",
        }
    },
}


class MigrationWorkflowTests(unittest.TestCase):
    def test_secret_uses_only_impersonated_migration_identity(self) -> None:
        url = "postgresql://user:secret@db.invalid/photos?sslmode=require&channel_binding=require"
        with (
            patch.object(migrate, "gcloud", return_value=url.encode()) as gcloud,
            patch.object(
                migrate, "trusted_ca_bundle", return_value=Path("/trusted/certifi.pem")
            ),
        ):
            result = migrate.migration_secret(CONFIG)
        self.assertIn("sslrootcert=%2Ftrusted%2Fcertifi.pem", result)
        self.assertIn("channel_binding=require", result)
        self.assertIn("sslmode=require", result)
        self.assertTrue(gcloud.call_args.kwargs["impersonate"])
        self.assertEqual(gcloud.call_args.kwargs["project"], PROJECT)
        self.assertEqual(
            gcloud.call_args.args[0],
            ["secrets", "versions", "access", "1", "--secret", "photointel-migration-database-url"],
        )

    def test_tls_url_replaces_system_ca_for_inspection_and_alembic(self) -> None:
        url = (
            "postgresql://user:verysecret@ep-test.neon.tech/db?"
            "sslmode=require&channel_binding=require&sslrootcert=system"
        )
        with patch.object(
            migrate, "trusted_ca_bundle", return_value=Path("/trusted/ca.pem")
        ):
            adjusted = migrate.migration_tls_url(url)
        self.assertIn("sslrootcert=%2Ftrusted%2Fca.pem", adjusted)
        self.assertNotIn("sslrootcert=system", adjusted)
        self.assertIn("channel_binding=require", adjusted)
        self.assertIn("verysecret", adjusted)
        self.assertEqual(
            migrate.classify_error("SSL error: certificate verify failed")[0],
            "NEON_CA",
        )

    def test_explicit_custom_ca_is_not_overwritten(self) -> None:
        raw = (
            "postgresql://user:p@ep-test.neon.tech/db?"
            "sslmode=verify-full&channel_binding=require"
            "&sslrootcert=%2Fsecrets%2Fcustom-ca.pem"
        )
        with patch.object(
            migrate, "trusted_ca_bundle", side_effect=AssertionError("not needed")
        ):
            adjusted = migrate.migration_tls_url(raw)
        self.assertIn("sslrootcert=%2Fsecrets%2Fcustom-ca.pem", adjusted)

    def test_trusted_ca_unavailable_fails_without_downgrading_tls(self) -> None:
        from unittest.mock import patch

        with patch.dict(sys.modules, {"certifi": None}):
            with self.assertRaisesRegex(
                migrate.MigrationError, "Missing certifi CA bundle"
            ):
                migrate.migration_tls_url(
                    "postgresql://u:p@ep-test.neon.tech/db?sslmode=require"
                )

    def test_gcloud_impersonation_never_exposes_secret_in_logs(self) -> None:
        class Fake:
            returncode = 1
            stdout = b"secret-data"
            stderr = b"password=ultra-private"

        with patch.object(migrate.subprocess, "run", return_value=Fake()) as proc:
            with self.assertRaises(migrate.MigrationError) as error:
                migrate.gcloud(
                    ["secrets", "versions", "access", "1", "--secret", "photointel-migration-database-url"],
                    project=PROJECT,
                    impersonate=True,
                )
        self.assertNotIn("ultra-private", str(error.exception))
        self.assertNotIn("secret-data", str(error.exception))
        self.assertIn(
            "--impersonate-service-account=photointel-migrate@photointel.iam.gserviceaccount.com",
            proc.call_args.args[0],
        )
        self.assertTrue(proc.call_args.kwargs["capture_output"])

    def test_missing_iam_role_has_specific_safe_diagnostic(self) -> None:
        class Denied:
            returncode = 1
            stdout = b""
            stderr = b"PERMISSION_DENIED iam.serviceAccounts.getAccessToken secret-private"

        with patch.object(migrate.subprocess, "run", return_value=Denied()):
            with self.assertRaises(migrate.MigrationError) as error:
                migrate.gcloud(
                    ["secrets", "versions", "access", "1", "--secret", "photointel-migration-database-url"],
                    project=PROJECT, impersonate=True,
                )
        self.assertIn("NEON_IAM", str(error.exception))
        self.assertIn("Setup GCP", str(error.exception))
        self.assertNotIn("secret-private", str(error.exception))

    def test_migration_url_validation_enforces_direct_neon_and_tls(self) -> None:
        import types

        class MockURL:
            drivername = "postgresql+psycopg"
            host = "ep-test-pooler.us-east-1.aws.neon.tech"
            query = {"sslmode": "verify-full"}

        fake_package = types.ModuleType("photointel")
        fake_db = types.ModuleType("photointel.db_connection")
        fake_db.database_connection_options = lambda *args, **kwargs: (MockURL(), {})
        with patch.dict(sys.modules, {
            "photointel": fake_package,
            "photointel.db_connection": fake_db,
        }):
            with self.assertRaises(migrate.MigrationError):
                migrate.connection_profile("postgresql://test:pass@ep-test-pooler/db")

    def test_empty_profile_refuses_existing_tables_and_revisions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps(CONFIG), encoding="utf-8")
            with (
                patch.object(migrate, "validate", return_value=CONFIG),
                patch.object(migrate, "migration_secret", return_value="NEVER_LOG_ME"),
                patch.object(migrate, "connection_profile", return_value=("conninfo", {})),
                patch.object(migrate, "inspect_database", return_value=migrate.Status("0004_filename_search_tokens", 8)),
                patch.object(migrate, "run_alembic") as alembic,
            ):
                code = migrate.main([
                    "--mode", "apply", "--project", PROJECT,
                    "--database", "initial-empty", "--config", str(config)
                ])
                self.assertEqual(code, 1)
                alembic.assert_not_called()

    def test_automated_verify_is_read_only_and_requires_matching_head(self) -> None:
        import types

        # GCP offline tests intentionally do not install Alembic.
        alembic = types.ModuleType("alembic")
        alembic_config = types.ModuleType("alembic.config")
        alembic_script = types.ModuleType("alembic.script")
        alembic_config.Config = lambda path: path

        class MockScript:
            @staticmethod
            def from_config(config):
                return MockScript()

            def get_heads(self):
                return ["expected_head"]

        alembic_script.ScriptDirectory = MockScript
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps(CONFIG), encoding="utf-8")
            for status, expected in (
                (migrate.Status("expected_head", 12), 0),
                (migrate.Status("base", 0), 1),
                (migrate.Status("unknown_revision", 12), 1),
            ):
                with self.subTest(status=status):
                    with (
                        patch.dict(sys.modules, {
                            "alembic": alembic,
                            "alembic.config": alembic_config,
                            "alembic.script": alembic_script,
                        }),
                        patch.object(migrate, "validate", return_value=CONFIG),
                        patch.object(migrate, "migration_secret", return_value="HIDDEN"),
                        patch.object(migrate, "connection_profile", return_value=("conninfo", {})),
                        patch.object(migrate, "inspect_database", return_value=status),
                        patch.object(migrate, "run_alembic") as alembic_command,
                    ):
                        self.assertEqual(migrate.main([
                            "--mode", "verify", "--project", PROJECT,
                            "--config", str(config)
                        ]), expected)
                        alembic_command.assert_not_called()

    def test_apply_requires_safety_choice(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps(CONFIG), encoding="utf-8")
            with (
                patch.object(migrate, "validate", return_value=CONFIG),
                patch.object(migrate, "migration_secret", return_value="HIDDEN"),
                patch.object(migrate, "connection_profile", return_value=("conninfo", {})),
                patch.object(migrate, "inspect_database", return_value=migrate.Status("base", 0)),
                patch.object(migrate, "run_alembic") as alembic,
            ):
                result = migrate.main([
                    "--mode", "apply", "--project", PROJECT, "--config", str(config),
                ])
                self.assertEqual(result, 1)
                alembic.assert_not_called()

    def test_empty_apply_runs_alembic_once_and_checks_after(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps(CONFIG), encoding="utf-8")
            with (
                patch.object(migrate, "validate", return_value=CONFIG),
                patch.object(migrate, "migration_secret", return_value="HIDDEN"),
                patch.object(migrate, "connection_profile", return_value=("conninfo", {})),
                patch.object(migrate, "inspect_database", side_effect=[
                    migrate.Status("base", 0), migrate.Status("0007_model_preprocessing_namespace", 7),
                ]) as inspect,
                patch.object(migrate, "run_alembic") as alembic,
            ):
                result = migrate.main([
                    "--mode", "apply", "--project", PROJECT,
                    "--database", "initial-empty", "--config", str(config),
                ])
                self.assertEqual(result, 0)
                alembic.assert_called_once_with("apply", "HIDDEN")
                self.assertEqual(inspect.call_count, 2)

    def test_plan_and_diagnose_never_run_upgrade(self) -> None:
        for mode in ("plan", "diagnose"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / "config.json"
                config.write_text(json.dumps(CONFIG), encoding="utf-8")
                with (
                    patch.object(migrate, "validate", return_value=CONFIG),
                    patch.object(migrate, "migration_secret", return_value="HIDDEN"),
                    patch.object(migrate, "connection_profile", return_value=("conninfo", {})),
                    patch.object(migrate, "inspect_database", return_value=migrate.Status("base", 0)),
                    patch.object(migrate, "run_alembic") as alembic,
                ):
                    self.assertEqual(migrate.main([
                        "--mode", mode, "--project", PROJECT, "--config", str(config),
                    ]), 0)
                    alembic.assert_called_once_with(mode, "HIDDEN")

    def test_backup_path_and_receipt_checked_before_upgrade(self) -> None:
        self.assertEqual(migrate.backup_prefix(PREFIX, PROJECT), PREFIX)
        for invalid in (
            "", "../other", "https://example.com/",
            f"gs://{PROJECT}-photointel-build-source/migration-backups/../foo",
        ):
            with self.assertRaises(migrate.MigrationError):
                migrate.backup_prefix(invalid, PROJECT)
        with (
            patch.object(migrate, "resolve_backup", return_value=PREFIX),
            patch.object(migrate.subprocess, "run") as download,
            patch.object(migrate, "verify_backup_receipt") as verify,
        ):
            download.return_value.returncode = 0
            # Mock must create the files that would be downloaded.
            def make_files(command, **kwargs):
                Path(command[4]).write_bytes(b"mock metadata")
                class Result:
                    returncode = 0
                return Result()
            download.side_effect = make_files
            with tempfile.TemporaryDirectory() as directory:
                migrate.validate_backup(PROJECT, "", Path(directory))
            self.assertEqual(verify.call_count, 1)

    def test_alembic_error_does_not_print_connection_url(self) -> None:
        class Fail:
            returncode = 1
            stdout = ""
            stderr = "OperationalError: password authentication failed for postgres://user:secretpass@host/db"
        with (
            patch.object(migrate.subprocess, "run", return_value=Fail()),
            patch("builtins.print") as output,
        ):
            with self.assertRaises(migrate.MigrationError):
                migrate.run_alembic("apply", "postgres://user:secretpass@host/db")
        printed = "\n".join(str(call) for call in output.call_args_list)
        self.assertNotIn("secretpass", printed)
        self.assertIn("NEON_AUTH", printed)


if __name__ == "__main__":
    unittest.main()
