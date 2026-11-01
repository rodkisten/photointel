"""Offline command/schema regressions; never contact Google Cloud."""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("gcp_manage", ROOT / "infra/gcp/manage.py")
assert SPEC and SPEC.loader
manage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manage)


class CloudRunCommandsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = json.loads((ROOT / "infra/gcp/config.example.json").read_text())
        self.config["image"] = self.config["image"].replace("REPLACE_GIT_SHA", "a" * 40)

    def test_sentry_secret_permissions_are_minimal_and_worker_has_dsn(self) -> None:
        self.config["secrets"]["SENTRY_DSN"] = {
            "name": "photointel-sentry-dsn", "version": "1"
        }
        self.config["secrets"]["SENTRY_API_TOKEN"] = {
            "name": "photointel-sentry-api-token", "version": "1"
        }
        self.config["workflow_secrets"]["SENTRY_AUTH_TOKEN"] = {
            "name": "photointel-sentry-build-token", "version": "1"
        }
        runtime = {
            mode: {item["name"] for item in manage.environment(self.config, mode)}
            for mode in ("api", "worker", "migrate")
        }
        self.assertIn("SENTRY_DSN", runtime["api"])
        self.assertIn("SENTRY_DSN", runtime["worker"])
        self.assertIn("SENTRY_API_TOKEN", runtime["api"])
        self.assertNotIn("SENTRY_API_TOKEN", runtime["worker"])
        self.assertNotIn("SENTRY_DSN", runtime["migrate"])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manage.bootstrap(manage.Runner(self.config, apply=False))
        commands = [
            line for line in output.getvalue().splitlines()
            if "secrets add-iam-policy-binding" in line
        ]
        self.assertTrue(any(
            "photointel-sentry-dsn" in line
            and "photointel-jobs@" in line for line in commands
        ))
        self.assertTrue(any(
            "photointel-sentry-api-token" in line
            and "photointel-api@" in line for line in commands
        ))
        self.assertFalse(any(
            "photointel-sentry-api-token" in line
            and "photointel-jobs@" in line for line in commands
        ))
        self.assertTrue(any(
            "photointel-sentry-build-token" in line
            and "photointel-deployer@" in line for line in commands
        ))
        workflow = (ROOT / ".github/workflows/deploy-worker.yml").read_text()
        build = workflow.split('name: "🏗 Build do frontend"', 1)[1]
        build = build.split('name: "📱 Build"', 1)[0]
        self.assertIn("CONFIRM_PROJECT: photointel", build)

    def test_default_plan_cannot_invoke_subprocess(self) -> None:
        with patch("subprocess.run", side_effect=AssertionError("network prohibited")):
            runner = manage.Runner(self.config, apply=False)
            with contextlib.redirect_stdout(io.StringIO()):
                manage.bootstrap(runner)
                manage.scheduler(runner)
                manage.deploy_jobs(runner, Path("/tmp/rendered"))

    def test_bootstrap_skips_enabled_apis_during_apply(self) -> None:
        class RecordingRunner:
            apply = True

            def __init__(self, enabled, config):
                self.config = config
                self.enabled = enabled
                self.commands = []

            def command(self, args, *, capture=False):
                self.commands.append(args)
                if args[:2] == ["services", "list"]:
                    return "\n".join(self.enabled)
                return ""

            def ensure(self, query, create):
                self.commands.append(["ensure", *query])

        complete = RecordingRunner(manage.SERVICES, self.config)
        with contextlib.redirect_stdout(io.StringIO()):
            manage.bootstrap(complete)
        self.assertFalse(any(cmd[:2] == ["services", "enable"] for cmd in complete.commands))

        partial = RecordingRunner(manage.SERVICES[:-1], self.config)
        with contextlib.redirect_stdout(io.StringIO()):
            manage.bootstrap(partial)
        enabled = [cmd for cmd in partial.commands if cmd[:2] == ["services", "enable"]]
        self.assertEqual(enabled, [["services", "enable", manage.SERVICES[-1]]])

    def test_bootstrap_grants_deployer_service_usage_consumer(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manage.bootstrap(manage.Runner(self.config, apply=False))
        plan = output.getvalue()
        self.assertIn("roles/serviceusage.serviceUsageConsumer", plan)
        self.assertIn("photointel-deployer@", plan)
        self.assertIn("roles/iam.serviceAccountUser", plan)
        self.assertIn("roles/logging.viewer", plan)
        self.assertIn("logging.googleapis.com", manage.SERVICES)
        self.assertIn("photointel-builder@", plan)

    def test_bootstrap_grants_terminal_builder_repo_scoped_writer_only(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manage.bootstrap(manage.Runner(self.config, apply=False))
        commands = [
            line for line in output.getvalue().splitlines()
            if "photointel-bootstrap@" in line
            and "roles/artifactregistry.writer" in line
        ]
        self.assertEqual(len(commands), 1)
        self.assertIn("artifacts repositories add-iam-policy-binding", commands[0])
        self.assertIn("--location", commands[0])
        self.assertNotIn("projects add-iam-policy-binding", commands[0])

    def test_api_scales_to_zero_request_billing_no_worker(self) -> None:
        document = manage.service(self.config)
        template = document["spec"]["template"]
        self.assertEqual(
            template["metadata"]["annotations"]["autoscaling.knative.dev/minScale"], "0"
        )
        self.assertEqual(
            template["metadata"]["annotations"]["run.googleapis.com/cpu-throttling"],
            "true",
        )
        container = template["spec"]["containers"][0]
        self.assertEqual(container["args"], ["/app/infra/gcp/entrypoint.py"])
        self.assertEqual(container["ports"], [{"containerPort": 8080}])
        self.assertNotIn("worker", " ".join(container["args"]))

    def test_every_job_is_finite_and_has_shutdown_margin(self) -> None:
        for mode in manage.MODES:
            with self.subTest(mode=mode):
                document = manage.job(self.config, mode)
                spec = document["spec"]["template"]["spec"]["template"]["spec"]
                args = spec["containers"][0]["args"]
                self.assertIn("--max-jobs", args)
                deadline = int(args[args.index("--deadline-seconds") + 1])
                self.assertGreaterEqual(int(spec["timeoutSeconds"]) - deadline, 60)
                self.assertEqual(args[1:3], ["photointel.services.task_runner", mode])

    def test_default_integrations_are_disabled_and_immutable_safety(self) -> None:
        env = {
            item["name"]: item.get("value")
            for item in manage.environment(self.config, "api")
        }
        for name in (
            "GPU_ENABLED",
            "ICLOUD_ENABLED",
            "APPLE_NATIVE_WRITE_ENABLED",
            "AUTO_DELETE_ENABLED",
        ):
            self.assertEqual(env[name], "false")
        self.assertEqual(env["INITIAL_IMPORT_LIMIT"], "100")
        self.assertEqual(env["CATALOG_ASSET_LIMIT"], "1000")
        self.assertEqual(env["DATABASE_MAX_OVERFLOW"], "0")

    def test_migration_credentials_isolated_from_application(self) -> None:
        api_names = {item["name"] for item in manage.environment(self.config, "api")}
        jobs_names = {item["name"] for item in manage.environment(self.config, "worker")}
        self.assertNotIn("MIGRATION_DATABASE_URL", api_names | jobs_names)
        self.assertNotIn("ICLOUD_SESSION_KEY", api_names)
        self.assertIn("ICLOUD_SESSION_KEY", jobs_names)
        self.assertIn(
            "MIGRATION_DATABASE_URL",
            {item["name"] for item in manage.environment(self.config, "migrate")},
        )

    def test_scheduler_uses_oauth_jobs_api_and_is_paused(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manage.scheduler(manage.Runner(self.config, apply=False))
        plan = output.getvalue()
        self.assertEqual(plan.count("--oauth-service-account-email"), 3)
        self.assertIn("https://run.googleapis.com/v2/projects/", plan)
        self.assertIn("/jobs/photointel-discover:run", plan)
        self.assertNotIn("--oidc", plan)
        self.assertEqual(plan.count("scheduler jobs pause"), 3)
        self.assertNotIn("photointel-backfill", plan)

    def test_scheduler_create_and_update_use_distinct_header_flags(self) -> None:
        class RecordingRunner:
            apply = True

            def __init__(self, config):
                self.config = config
                self.commands = []

            def command(self, args, *, capture=False):
                self.commands.append(args)
                return ""

        class DescribeResult:
            def __init__(self, exists):
                self.returncode = 0 if exists else 1
                self.stderr = "" if exists else "NOT_FOUND"

        # All existing jobs: updating must use --update-headers, never --headers.
        updating = RecordingRunner(self.config)
        with patch("subprocess.run", return_value=DescribeResult(True)) as describe:
            manage.scheduler(updating)
        self.assertEqual(describe.call_count, 3)
        updates = [command for command in updating.commands if command[:4] == [
            "scheduler", "jobs", "update", "http"
        ]]
        self.assertEqual(len(updates), 3)
        for command in updates:
            self.assertIn("--update-headers", command)
            self.assertNotIn("--headers", command)
            self.assertEqual(command[command.index("--update-headers") + 1],
                             "Content-Type=application/json")
            self.assertIn("--oauth-service-account-email", command)
            self.assertIn("--message-body", command)
        self.assertEqual(
            len([cmd for cmd in updating.commands if cmd[:3] ==
                 ["scheduler", "jobs", "pause"]]), 3
        )

        # All absent jobs: creation still requires --headers.
        creating = RecordingRunner(self.config)
        with patch("subprocess.run", return_value=DescribeResult(False)):
            manage.scheduler(creating)
        creates = [command for command in creating.commands if command[:4] == [
            "scheduler", "jobs", "create", "http"
        ]]
        self.assertEqual(len(creates), 3)
        for command in creates:
            self.assertIn("--headers", command)
            self.assertNotIn("--update-headers", command)
            self.assertEqual(command[command.index("--headers") + 1],
                             "Content-Type=application/json")
        self.assertEqual(
            len([cmd for cmd in creating.commands if cmd[:3] ==
                 ["scheduler", "jobs", "pause"]]), 3
        )

    def test_job_invocation_rights_are_named_and_exclude_migration(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            manage.deploy_jobs(
                manage.Runner(self.config, apply=False), Path("/tmp/rendered")
            )
        bindings = [
            line
            for line in output.getvalue().splitlines()
            if "add-iam-policy-binding" in line
        ]
        self.assertEqual(len(bindings), 11)
        self.assertTrue(all("roles/run.invoker" in line for line in bindings))
        self.assertTrue(all("photointel-migrate" not in line for line in bindings))
        self.assertTrue(
            all("projects add-iam-policy-binding" not in line for line in bindings)
        )

    def test_mutation_requires_both_explicit_authorizations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            production = copy.deepcopy(self.config)
            serialized = json.dumps(production).replace(
                "replace-project-id", "photo-test-prod"
            )
            serialized = serialized.replace("replace-team", "photo-test-team")
            serialized = serialized.replace("REPLACE_ACCESS_AUDIENCE", "a" * 64)
            serialized = serialized.replace("REPLACE_ACCOUNT", "a" * 32)
            serialized = serialized.replace(
                "replace@example.com", "owner@phototest.invalid"
            )
            serialized = serialized.replace(
                "photos.example.com", "photos.phototest.invalid"
            )
            path.write_text(serialized)
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "infra/gcp/manage.py"),
                    "bootstrap",
                    "--config",
                    str(path),
                    "--apply",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("--authorize-charges --confirm-project", result.stderr)
            self.assertEqual(result.stdout, "")

    def test_image_must_be_commit_or_digest(self) -> None:
        self.config["image"] = self.config["image"].rsplit(":", 1)[0] + ":latest"
        with self.assertRaises(manage.ConfigurationError):
            manage.validate(self.config)

    def test_secret_values_cannot_be_extra_environment(self) -> None:
        self.config["extra_environment"] = {"MODAL_TOKEN": "private-value"}
        with self.assertRaises(manage.ConfigurationError):
            manage.validate(self.config)

    def test_latest_secret_version_is_rejected(self) -> None:
        self.config["secrets"]["DATABASE_URL"]["version"] = "latest"
        with self.assertRaises(manage.ConfigurationError):
            manage.validate(self.config)

    def test_job_mode_cannot_be_injected(self) -> None:
        with self.assertRaises(manage.ConfigurationError):
            manage.job(self.config, "worker; rm -rf /")

    def test_render_secrets_are_references_and_files_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            paths = manage.render(self.config, Path(directory))
            self.assertEqual(len(paths), 6)
            for path in paths:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            document = json.loads(paths[0].read_text())
            env = document["spec"]["template"]["spec"]["containers"][0]["env"]
            secret = next(item for item in env if item["name"] == "DATABASE_URL")
            self.assertNotIn("value", secret)
            self.assertEqual(secret["valueFrom"]["secretKeyRef"]["key"], "1")

    def test_source_upload_excludes_credentials_and_local_state(self) -> None:
        ignore = (ROOT / "infra/gcp/build.gcloudignore").read_text().splitlines()
        for pattern in (
            ".env",
            ".env.*",
            "var/**",
            "backups/**",
            "infra/gcp/config.local.json",
        ):
            self.assertIn(pattern, ignore)

    def test_public_bridge_identifiers_can_be_configured_without_client_secrets(
        self,
    ) -> None:
        self.config["extra_environment"] = {
            "ACCESS_BRIDGE_SERVICE_TOKENS": '["public-client-id.access"]',
            "ACCESS_BRIDGE_AUDIENCE": "bridge-audience",
        }
        manage.validate(self.config)
        self.config["extra_environment"]["ACCESS_BRIDGE_SERVICE_TOKENS"] = '"not-a-list"'
        with self.assertRaises(manage.ConfigurationError):
            manage.validate(self.config)

    def test_migration_backup_receipt_binds_the_encrypted_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            encrypted = b"synthetic-test-ciphertext-not-personal-data"
            (path / "manifest.enc").write_bytes(encrypted)
            header = {
                "format": "photointel-application-backup-v2",
                "backup_id": "a" * 32,
                "manifest_sha256": hashlib.sha256(encrypted).hexdigest(),
            }
            (path / "backup.json").write_text(json.dumps(header))
            receipt = {
                "verification_kind": "database-and-object-restore",
                "backup_id": header["backup_id"],
                "manifest_sha256": header["manifest_sha256"],
                "status": "passed",
                "verified_at": datetime.now(UTC).isoformat(),
                "files_verified": 3,
                "database_fingerprints_match": True,
                "migration_heads": ["0006_query_embedding_cache"],
                "objects_restored_and_read_back": 1,
            }
            receipt_path = path / "receipt.json"
            receipt_path.write_text(json.dumps(receipt))
            manage.verify_backup_receipt(path, receipt_path)
            receipt["verification_kind"] = "authenticated-content-integrity"
            receipt_path.write_text(json.dumps(receipt))
            with self.assertRaises(manage.ConfigurationError):
                manage.verify_backup_receipt(path, receipt_path)
            receipt["verification_kind"] = "database-and-object-restore"
            receipt_path.write_text(json.dumps(receipt))
            (path / "manifest.enc").write_bytes(b"tampered-ciphertext")
            with self.assertRaises(manage.ConfigurationError):
                manage.verify_backup_receipt(path, receipt_path)

    def test_source_provenance_is_exposed_without_secret_payloads(self) -> None:
        env = {
            item["name"]: item.get("value")
            for item in manage.environment(self.config, "api")
        }
        self.assertEqual(env["RELEASE_GIT_SHA"], "a" * 40)
        self.assertEqual(env["EXECUTION_PLATFORM"], "cloud_run")
        self.assertEqual(env["VERIFICATION_GATES_ENFORCED"], "true")

    def test_api_does_not_trust_forwarded_headers(self) -> None:
        entrypoint = (ROOT / "infra/gcp/entrypoint.py").read_text()
        self.assertIn('"--no-proxy-headers"', entrypoint)
        self.assertNotIn('"--forwarded-allow-ips"', entrypoint)


if __name__ == "__main__":
    unittest.main()
