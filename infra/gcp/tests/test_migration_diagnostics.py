"""Offline tests for migration troubleshooting; never contacts Google Cloud."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "diagnose_migration", ROOT / "infra/gcp/diagnose_migration.py"
)
assert SPEC and SPEC.loader
diagnose = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diagnose)
PROJECT = "photointel"
REGION = "us-central1"
NAME = "photointel-migrate-sbrpk"


class MigrationDiagnosticsTests(unittest.TestCase):
    def test_safe_excerpts_preserve_errors_not_secret_values(self):
        entries = [
            {"textPayload": "Traceback (most recent call last):"},
            {"textPayload": '  File "/app/infra/migrations/env.py", line 93, in connect'},
            {"textPayload": "sqlalchemy.exc.OperationalError: connection timed out"},
            {"textPayload": "ValueError: DATABASE_URL=postgresql://user:real-secret@neon.invalid/db"},
            {"textPayload": "password=real-secret"},
            {"textPayload": "authorization: Bearer secretABC"},
            {"textPayload": "SQL> SELECT * FROM private_photos"},
        ]
        lines = diagnose.excerpts(entries)
        self.assertIn("sqlalchemy.exc.OperationalError: connection timed out", lines)
        self.assertIn("Traceback (most recent call last):", lines)
        rendered = "\n".join(lines)
        self.assertNotIn("real-secret", rendered)
        self.assertNotIn("private_photos", rendered)
        self.assertNotIn("secretABC", rendered)
        self.assertNotIn("SELECT *", rendered)

    def test_classification_only_returns_safe_fixed_guidance(self):
        text = "password authentication failed for user=alice secret_password=hide"
        signals = diagnose.classify([{"textPayload": text}])
        self.assertIn("DATABASE_AUTH", [code for code, _ in signals])
        self.assertNotIn("alice", repr(signals))
        self.assertNotIn("hide", repr(signals))

    def test_cloud_logging_filter_ties_entries_to_exact_execution(self):
        with patch.object(diagnose, "run_readonly", return_value=[]) as query:
            self.assertEqual(diagnose.run_logs(PROJECT, REGION, NAME), [])
        args = query.call_args.args[0]
        self.assertEqual(args[:2], ["logging", "read"])
        self.assertIn('resource.type="cloud_run_job"', args[2])
        self.assertIn(f'labels.execution_name="{NAME}"', args[2])
        self.assertIn(f'resource.labels.location="{REGION}"', args[2])
        self.assertNotIn("secrets", " ".join(args))

    def test_readonly_command_does_not_echo_sensitive_gcloud_errors(self):
        class ErrorResult:
            returncode = 1
            stdout = ""
            stderr = "PERMISSION_DENIED for account user@example.invalid secretpassword"

        with patch.object(diagnose.subprocess, "run", return_value=ErrorResult()) as proc:
            with self.assertRaises(PermissionError):
                diagnose.run_readonly(["logging", "read", "safe filter"], PROJECT)
        args = proc.call_args.args[0]
        self.assertNotIn("execute", args)
        self.assertIn("--format=json", args)
        self.assertTrue(proc.call_args.kwargs["capture_output"])

    def test_select_exact_new_execution_using_start_window(self):
        started = datetime.now(UTC)
        recent = started + timedelta(seconds=5)
        prior = started - timedelta(minutes=10)
        values = [
            {"name": "photointel-migrate-old01", "createTime": prior.isoformat()},
            {"name": NAME, "createTime": recent.isoformat()},
        ]

        def response(args, project, **_kwargs):
            if "list" in args:
                return values
            return {"name": NAME, "status": {"failedCount": 1}}

        with patch.object(diagnose, "run_readonly", side_effect=response):
            name, details = diagnose.find_execution(
                PROJECT, REGION, started_after=started.isoformat()
            )
        self.assertEqual(name, NAME)
        self.assertEqual(details["status"]["failedCount"], 1)

    def test_ambiguous_concurrent_executions_do_not_guess(self):
        moment = datetime.now(UTC).isoformat()
        values = [
            {"name": NAME, "createTime": moment},
            {"name": "photointel-migrate-other1", "createTime": moment},
        ]
        with patch.object(diagnose, "run_readonly", return_value=values):
            with self.assertRaisesRegex(ValueError, "Multiple migrations"):
                diagnose.find_execution(
                    PROJECT, REGION, started_after=moment
                )

    def test_diagnose_writes_summary_and_instructions_on_iam_denial(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            summary = Path(directory) / "summary.md"
            config.write_text(json.dumps({"project_id": PROJECT, "region": REGION}))
            with (
                patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}),
                patch.object(
                    diagnose, "find_execution",
                    return_value=(NAME, {"status": {"failedCount": 1}}),
                ),
                patch.object(diagnose, "run_readonly", return_value=[]),
                patch.object(diagnose, "run_logs", side_effect=PermissionError("denied")),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                status = diagnose.main(
                    ["--project", PROJECT, "--config", str(config)]
                )
            self.assertEqual(status, 0)
            report = summary.read_text()
            self.assertIn(NAME, report)
            self.assertIn("roles/logging.viewer", report)
            self.assertIn("Open execution details", report)
            self.assertNotIn("denied", report.lower())

    def test_invalid_manual_execution_name_is_rejected(self):
        for value in (
            "../../other-project", "photointel-other-abc", "bad;drop", "",
        ):
            if value:
                with self.assertRaises(ValueError):
                    diagnose.clean_execution_name(value)


if __name__ == "__main__":
    unittest.main()
