"""Offline contract tests: every infrastructure caller shares one safe gcloud transport."""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra/gcp"))
import cloud_cli


class CloudCLIContractTests(unittest.TestCase):
    def test_project_is_explicit_and_normalized_once(self):
        command = cloud_cli.command(
            ["run", "jobs", "describe", "photointel-worker", "--project", "photointel", "--quiet"],
            project="photointel",
        )
        self.assertEqual(command[0], "gcloud")
        self.assertEqual(command.count("--project=photointel"), 1)
        self.assertNotIn("--project", command)
        self.assertEqual(command.count("--quiet"), 1)

    def test_reject_ambiguous_scope_or_injected_project(self):
        for args, project in [
            (["run", "jobs", "list"], None),
            (["run", "jobs", "list", "--project=other-project"], "photointel"),
            (["run", "jobs", "list", "--project", "other-project"], "photointel"),
            (["run", "jobs", "list", "--project="], "photointel"),
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                cloud_cli.command(args, project=project)
        with self.assertRaises(ValueError):
            cloud_cli.command(["run", "jobs", "list"], project="x;sh")

    def test_no_shell_and_no_silent_auth_mutation(self):
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "ok", "")) as run:
            result = cloud_cli.run(["run", "jobs", "list"], project="photointel", timeout=45)
            self.assertEqual(result.stdout, "ok")
            invocation = run.call_args.args[0]
            self.assertEqual(invocation[0], "gcloud")
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertFalse(any("login" == x for x in invocation))
            self.assertEqual(run.call_args.kwargs["timeout"], 45)

    def test_impersonation_must_be_explicit_and_scope_bound(self):
        command = cloud_cli.command(
            ["secrets", "versions", "access", "1", "--secret", "my-secret"],
            project="photointel",
            impersonate="photointel-migrate@photointel.iam.gserviceaccount.com",
        )
        self.assertIn(
            "--impersonate-service-account=photointel-migrate@photointel.iam.gserviceaccount.com",
            command,
        )
        with self.assertRaises(ValueError):
            cloud_cli.command(["secrets", "versions", "access", "1"], project="photointel",
                              impersonate="attacker@example.org")

    def test_error_message_only_contains_safe_reason_and_permission_name(self):
        stderr = ('PERMISSION_DENIED: command failed. Bearer top-secret '
                  'Required permission compute.instances.setMetadata secret_token=PRIVATE')
        info = cloud_cli.classify(stderr)
        self.assertEqual(info.code, "PERMISSION_DENIED")
        self.assertIn("compute.instances.setMetadata", info.permissions)
        error = cloud_cli.CloudCommandError(
            ["secrets", "versions", "access", "some/secret/url"], info, 1,
        )
        self.assertNotIn("top-secret", str(error))
        self.assertNotIn("PRIVATE", str(error))
        self.assertNotIn("some/secret/url", str(error))

    def test_cli_forwards_binary_stdout_without_leaking_stderr(self):
        # Bytes returned from Secret Manager are preserved exactly for callers.
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"secret", b"")):
            self.assertEqual(cloud_cli.run(["secrets", "versions", "access", "1"],
                                           project="photointel", text=False).stdout, b"secret")

    def test_bash_and_node_adapter_paths_are_shared(self):
        shell = (ROOT / "infra/gcp/bootstrap.sh").read_text()
        wif = (ROOT / "infra/gcp/bootstrap_manage_wif.sh").read_text()
        node = (ROOT / "infra/gcp/manage.mjs").read_text()
        self.assertIn('cloud_cli.py', shell)
        self.assertIn('cloud_cli.py', wif)
        self.assertIn("gcloudInvocation(args)", node)

    def test_all_critical_python_commands_use_the_shared_transport(self):
        paths = [
            "infra/gcp/manage.py",
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
        ]
        for path in paths:
            with self.subTest(path=path):
                content = (ROOT / path).read_text()
                self.assertIn("cloud_cli import", content)
                self.assertNotIn('["gcloud",', content)
                self.assertNotIn("['gcloud',", content)


if __name__ == "__main__":
    unittest.main()
