"""Regression tests for safe legacy Telegram config compatibility."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
import unittest
from pathlib import Path

GCP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GCP))
spec = importlib.util.spec_from_file_location("gcp_env", GCP / "gcp-env.py")
assert spec and spec.loader
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)


class LegacyTelegramConfigurationTests(unittest.TestCase):
    def test_strips_plaintext_secret_and_computed_flag_without_leaking_values(self):
        token = "SECRET_VALUE_NOT_FOR_LOGS_1234567890"
        config = {
            "project_id": "photointel",
            "extra_environment": {
                "TELEGRAM_NOTIFICATION_API_TOKEN": token,
                "TELEGRAM_JOB_EVENTS_ENABLED": "true",
                "TELEGRAM_NOTIFICATION_URL": "https://xtelegram-cf.migos.club/notifications/send",
                "TELEGRAM_NOTIFICATION_CHAT_ID": "-10012345",
            },
            "telegram_notification_api_token": token,
            "telegram_job_events_enabled": "true",
        }
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            normalized = loader.normalize_legacy_notification_fields(config)
        self.assertNotIn("TELEGRAM_NOTIFICATION_API_TOKEN", normalized["extra_environment"])
        self.assertNotIn("TELEGRAM_JOB_EVENTS_ENABLED", normalized["extra_environment"])
        self.assertNotIn("telegram_notification_api_token", normalized)
        self.assertNotIn("telegram_job_events_enabled", normalized)
        self.assertIn("TELEGRAM_NOTIFICATION_URL", normalized["extra_environment"])
        self.assertIn("TELEGRAM_NOTIFICATION_CHAT_ID", normalized["extra_environment"])
        self.assertNotIn(token, stdout.getvalue())
        self.assertIn("SECRETS__TELEGRAM_NOTIFICATION_API_TOKEN__NAME", stdout.getvalue())

    def test_dotenv_conversion_normalizes_protected_fields(self):
        entries = {
            "PROJECT_ID": "photointel",
            "REGION": "us-central1",
            "EXTRA_ENVIRONMENT__TELEGRAM_JOB_EVENTS_ENABLED": "true",
            "EXTRA_ENVIRONMENT__TELEGRAM_NOTIFICATION_API_TOKEN": "INLINE_CREDENTIAL",
            "SECRETS__TELEGRAM_NOTIFICATION_API_TOKEN__NAME": "photointel-telegram-relay",
            "SECRETS__TELEGRAM_NOTIFICATION_API_TOKEN__VERSION": "2",
        }
        with contextlib.redirect_stdout(io.StringIO()):
            parsed = loader.normalize_legacy_notification_fields(loader.decode_config(entries))
        self.assertNotIn("TELEGRAM_JOB_EVENTS_ENABLED", parsed["extra_environment"])
        self.assertNotIn("TELEGRAM_NOTIFICATION_API_TOKEN", parsed["extra_environment"])
        self.assertEqual(parsed["secrets"]["TELEGRAM_NOTIFICATION_API_TOKEN"],
                         {"name": "photointel-telegram-relay", "version": "2"})

    def test_unrelated_protected_overrides_are_not_whitelisted(self):
        config = {"extra_environment": {
            "DATABASE_URL": "should-not-be-authorized",
            "TELEGRAM_NOTIFICATION_API_TOKEN": "legacy",
        }}
        with contextlib.redirect_stdout(io.StringIO()):
            parsed = loader.normalize_legacy_notification_fields(config)
        self.assertIn("DATABASE_URL", parsed["extra_environment"])


if __name__ == "__main__":
    unittest.main()
