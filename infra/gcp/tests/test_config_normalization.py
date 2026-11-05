"""Offline tests for direct Telegram relay configuration (Secret Manager optional)."""
from __future__ import annotations

import contextlib
import io
import json
import unittest

from infra.gcp import gcp_env as loader
from infra.gcp.manage import environment


class TelegramEnvTests(unittest.TestCase):
    TOKEN = "FAKE_INLINE_TOKEN_FOR_TESTS_12345678"

    def test_top_level_dotenv_direct_settings_are_canonicalized(self):
        entries = {
            "PROJECT_ID": "photointel",
            "REGION": "us-central1",
            "TELEGRAM_NOTIFICATION_API_TOKEN": self.TOKEN,
            "TELEGRAM_NOTIFICATION_URL": "https://xtelegram-cf.migos.club/notifications/send",
            "TELEGRAM_NOTIFICATION_CHAT_ID": "-10012345:2",
            "TELEGRAM_JOB_EVENTS_ENABLED": "true",
        }
        with contextlib.redirect_stdout(io.StringIO()) as log:
            parsed = loader.normalize_legacy_notification_fields(loader.decode_config(entries))
        self.assertNotIn("telegram_notification_api_token", parsed)
        self.assertNotIn("telegram_notification_url", parsed)
        self.assertNotIn("telegram_notification_chat_id", parsed)
        self.assertNotIn("telegram_job_events_enabled", parsed)
        self.assertEqual(parsed["extra_environment"]["TELEGRAM_NOTIFICATION_API_TOKEN"], self.TOKEN)
        self.assertEqual(parsed["extra_environment"]["TELEGRAM_NOTIFICATION_CHAT_ID"], "-10012345:2")
        self.assertNotIn("TELEGRAM_JOB_EVENTS_ENABLED", parsed["extra_environment"])
        self.assertNotIn(self.TOKEN, log.getvalue())

    def test_prefixed_dotenv_token_has_precedence_and_does_not_leak_into_preview(self):
        entries = {
            "EXTRA_ENVIRONMENT__TELEGRAM_NOTIFICATION_API_TOKEN": self.TOKEN,
            "TELEGRAM_NOTIFICATION_API_TOKEN": "FAKE_FALLBACK_TOKEN_UNUSED_12345678",
            "EXTRA_ENVIRONMENT__TELEGRAM_JOB_EVENTS_ENABLED": "false",
        }
        with contextlib.redirect_stdout(io.StringIO()):
            config = loader.normalize_legacy_notification_fields(loader.decode_config(entries))
        self.assertEqual(config["extra_environment"]["TELEGRAM_NOTIFICATION_API_TOKEN"], self.TOKEN)
        self.assertEqual(
            loader.redact_preview(config)["extra_environment"]["TELEGRAM_NOTIFICATION_API_TOKEN"],
            "<redacted>",
        )

    def test_inline_overrides_optional_secret_manager_reference_in_runtime(self):
        example = json.loads((GCP / "config.example.json").read_text(encoding="utf8"))
        example["extra_environment"] = {
            "TELEGRAM_NOTIFICATION_API_TOKEN": self.TOKEN,
            "TELEGRAM_NOTIFICATION_URL": "https://xtelegram-cf.migos.club/notifications/send",
            "TELEGRAM_NOTIFICATION_CHAT_ID": "-10012345",
        }
        example["secrets"]["TELEGRAM_NOTIFICATION_API_TOKEN"] = {
            "name": "old-telegram-secret", "version": "1"
        }
        for mode in ("api", "worker"):
            entries = environment(example, mode)
            token = [entry for entry in entries if entry["name"] == "TELEGRAM_NOTIFICATION_API_TOKEN"]
            self.assertEqual(token, [{"name": "TELEGRAM_NOTIFICATION_API_TOKEN", "value": self.TOKEN}])
            self.assertEqual(
                next(item["value"] for item in entries if item["name"] == "TELEGRAM_JOB_EVENTS_ENABLED"),
                "true",
            )
        migration = environment(example, "migrate")
        self.assertFalse(any(item["name"] == "TELEGRAM_NOTIFICATION_API_TOKEN" for item in migration))

    def test_unrelated_secret_overrides_are_not_whitelisted(self):
        config = {"extra_environment": {
            "DATABASE_URL": "not-authorized",
            "TELEGRAM_NOTIFICATION_API_TOKEN": self.TOKEN,
        }}
        with contextlib.redirect_stdout(io.StringIO()):
            parsed = loader.normalize_legacy_notification_fields(config)
        self.assertIn("DATABASE_URL", parsed["extra_environment"])


if __name__ == "__main__":
    unittest.main()
