"""Offline tests for Cloud Run startup diagnosis. Never contacts Google Cloud."""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "diagnose_startup", ROOT / "infra/gcp/diagnose_startup.py"
)
assert SPEC is not None and SPEC.loader is not None
diagnose = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diagnose)


class CloudRunStartupDiagnosticsTests(unittest.TestCase):
    def test_neon_configuration_error_has_safe_remediation(self) -> None:
        entries = [{
            "textPayload": (
                "ValueError: asyncpg does not support channel_binding=require "
                "postgresql://myuser:extremely-sensitive-password@example.invalid/db"
            )
        }]
        signals = diagnose.classify_entries(entries)
        self.assertIn("NEON_CHANNEL_BINDING", [code for code, _ in signals])
        self.assertNotIn("extremely-sensitive-password", repr(signals))

    def test_missing_module_is_reported_without_provider_log_values(self) -> None:
        signals = diagnose.classify_entries([
            {"jsonPayload": {"message": "ModuleNotFoundError: No module named 'private_name'"}}
        ])
        self.assertIn("MISSING_PYTHON_MODULE", [code for code, _ in signals])
        self.assertNotIn("private_name", repr(signals))

    def test_unrecognized_sensitive_messages_are_never_echoed(self) -> None:
        self.assertEqual(
            diagnose.classify_entries([
                {"textPayload": "PRIVATE_TOKEN=not-for-ci-logs"},
                {"jsonPayload": {"message": "hidden-password"}},
            ]),
            [],
        )

    def test_readiness_neon_and_r2_signals_are_separated_without_secret_leaks(self) -> None:
        entries = [
            {"textPayload": "readiness_neon_failed private-password=NEVER_PRINT"},
            {"jsonPayload": {"message": "readiness_r2_failed secret_key=NEVER_PRINT"}},
        ]
        signals = diagnose.classify_entries(entries)
        codes = [code for code, _ in signals]
        self.assertIn("NEON_HEALTH_FAILED", codes)
        self.assertIn("R2_HEALTH_FAILED", codes)
        self.assertNotIn("NEVER_PRINT", repr(signals))

    def test_only_neon_readiness_event_does_not_blame_r2(self) -> None:
        codes = [code for code, _ in diagnose.classify_entries([
            {"textPayload": "readiness_neon_failed"}
        ])]
        self.assertIn("NEON_HEALTH_FAILED", codes)
        self.assertNotIn("R2_HEALTH_FAILED", codes)

    def test_read_only_logging_query(self) -> None:
        class FakeCompleted:
            returncode = 0
            stdout = '[{"textPayload":"ModuleNotFoundError"}]'

        with patch.object(diagnose.subprocess, "run", return_value=FakeCompleted()) as run:
            entries = diagnose.read_logs("photointel", "photointel-api", "us-central1")
        self.assertEqual(len(entries), 1)
        args = run.call_args.args[0]
        self.assertEqual(args[:3], ["gcloud", "logging", "read"])
        self.assertIn("--project", args)
        self.assertNotIn("secrets", args)
        self.assertTrue(run.call_args.kwargs["capture_output"])


if __name__ == "__main__":
    unittest.main()
