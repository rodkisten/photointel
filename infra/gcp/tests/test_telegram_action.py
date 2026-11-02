"""Offline regression tests for the shared Telegram Notify composite action."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[3]
ACTION = ROOT / ".github/actions/notify/action.yml"


def telegram_script() -> str:
    source = ACTION.read_text(encoding="utf8")
    section = source.split('    - name: "📨 Notify Telegram"', 1)[1]
    raw = section.split("      run: |\n", 1)[1]
    return textwrap.dedent(raw)


class TelegramActionTests(unittest.TestCase):
    def test_script_syntax(self) -> None:
        result = subprocess.run(["bash", "-n"], input=telegram_script(), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_reads_gcp_secret_and_sends_one_mutable_message(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            config = tmp / "config.json"
            config.write_text(json.dumps({
                "secrets": {"TELEGRAM_NOTIFICATION_API_TOKEN": {
                    "name": "photointel-telegram-relay-token", "version": "1"
                }},
                "extra_environment": {
                    "TELEGRAM_NOTIFICATION_URL": "https://xtelegram-cf.migos.club/notifications/send",
                    "TELEGRAM_NOTIFICATION_CHAT_ID": "-10012345:72",
                }
            }), encoding="utf8")
            gcloud = tmp / "gcloud"
            gcloud.write_text('#!/bin/sh\necho TEST_TELEGRAM_RELAY_TOKEN_1234567890\n', encoding="utf8")
            curl = tmp / "curl"
            curl.write_text(
                '#!/bin/sh\ncat > "$CAPTURE"\nprintf \'{"ok":true,"message_id":42}\\n\'\n',
                encoding="utf8",
            )
            gcloud.chmod(0o755)
            curl.chmod(0o755)
            capture = tmp / "message.json"
            env = dict(os.environ)
            env.update({
                "PATH": str(tmp) + os.pathsep + os.environ["PATH"],
                "GCP_CONFIG_FILE": str(config),
                "CAPTURE": str(capture),
                "TELEGRAM_TOKEN": "",
                "ACTION": "step",
                "WORKFLOW_LABEL": "Deploy",
                "JOB_LABEL": "release",
                "STEP_LABEL": "Build",
                "PHASE_LABEL": "Build",
                "STEP_OUTCOME": "success",
                "NOTIFY_COMPLETED": "2",
                "NOTIFY_TOTAL": "4",
                "RUN_URL": "https://github.com/rodkisten/photointel/actions/runs/123",
                "RUN_ID": "123",
                "RUN_ATTEMPT": "1",
                "REPOSITORY": "rodkisten/photointel",
            })
            result = subprocess.run(
                ["bash", "-e", "-c", telegram_script()],
                cwd=ROOT, env=env, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(capture.read_text(encoding="utf8"))
            self.assertEqual(payload["chat_id"], "-10012345:72")
            self.assertEqual(payload["notification_key"], "workflow:rodkisten/photointel:123")
            self.assertEqual(payload["sequence"], 100102)
            self.assertIn("Etapa concluída", payload["body"])
            self.assertEqual(len(payload["buttons"]), 1)

    def test_inline_dotenv_token_precedes_existing_google_secret_reference(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            config = tmp / "config.json"
            config.write_text(json.dumps({
                "secrets": {"TELEGRAM_NOTIFICATION_API_TOKEN": {
                    "name": "old-telegram-secret", "version": "1",
                }},
                "extra_environment": {
                    "TELEGRAM_NOTIFICATION_API_TOKEN": "FAKE_INLINE_TOKEN_FOR_TESTS_12345678",
                    "TELEGRAM_NOTIFICATION_URL": "https://xtelegram-cf.migos.club/notifications/send",
                    "TELEGRAM_NOTIFICATION_CHAT_ID": "-10012345",
                },
            }), encoding="utf8")
            gcloud = tmp / "gcloud"
            marker = tmp / "secret-was-read"
            gcloud.write_text('#!/bin/sh\ntouch "$GOOGLE_READ_MARKER"\nexit 99\n', encoding="utf8")
            curl = tmp / "curl"
            curl.write_text('#!/bin/sh\ncat > "$CAPTURE"\nprintf \'{"ok":true}\n\'\n', encoding="utf8")
            gcloud.chmod(0o755)
            curl.chmod(0o755)
            capture = tmp / "payload.json"
            env = dict(os.environ)
            env.update({
                "PATH": str(tmp) + os.pathsep + os.environ["PATH"],
                "GCP_CONFIG_FILE": str(config),
                "GOOGLE_READ_MARKER": str(marker),
                "CAPTURE": str(capture),
                "TELEGRAM_TOKEN": "",
                "ACTION": "end",
                "WORKFLOW_LABEL": "Deploy",
                "JOB_LABEL": "deploy",
                "STEP_OUTCOME": "success",
                "NOTIFY_COMPLETED": "3",
                "NOTIFY_TOTAL": "3",
                "RUN_URL": "https://github.com/rodkisten/photointel/actions/runs/123",
                "RUN_ID": "123",
                "RUN_ATTEMPT": "1",
                "REPOSITORY": "rodkisten/photointel",
            })
            result = subprocess.run(
                ["bash", "-e", "-c", telegram_script()],
                cwd=ROOT, env=env, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists(), "Inline token must not trigger a GCP secret read")
            self.assertTrue(capture.exists(), "Telegram request must be issued")
            self.assertEqual(json.loads(capture.read_text())["chat_id"], "-10012345")
            self.assertNotIn("FAKE_INLINE_TOKEN_FOR_TESTS", result.stdout + result.stderr)

    def test_missing_secret_reports_skipped_without_contacting_relay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            env = dict(os.environ)
            env.update({
                "PATH": str(tmp) + os.pathsep + os.environ["PATH"],
                "GCP_CONFIG_FILE": str(tmp / "missing.json"),
                "TELEGRAM_TOKEN": "",
            })
            result = subprocess.run(
                ["bash", "-e", "-c", telegram_script()],
                cwd=ROOT, env=env, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0)
            self.assertIn("Telegram skipped", result.stdout)


if __name__ == "__main__":
    unittest.main()
