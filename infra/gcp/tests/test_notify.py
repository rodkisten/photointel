"""Offline Notify! transport and GitHub workflow instrumentation regressions."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("notify_adapter", ROOT / "infra/notify/notify.py")
assert SPEC and SPEC.loader
notify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notify)

WORKFLOWS = (
    "bootstrap-validation.yml", "ci.yml", "compose-validation.yml",
    "container-architectures.yml", "deploy-pages.yml", "gcp-bootstrap.yml",
    "gcp-deploy.yml", "gcp-validation.yml", "real-cpu-smoke.yml",
    "release-manifest.yml", "ssh.yml", "webkit-validation.yml", "zip.yml",
)


class FakeResponse:
    def __init__(self, content):
        self.content = json.dumps(content).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit):
        return self.content


class NotifyOfflineTests(unittest.TestCase):
    def test_requests_use_json_and_new_activity_ids(self):
        requests = []

        def respond(request, timeout=0):
            requests.append(request)
            assert timeout <= 7
            if len(requests) == 1:
                return FakeResponse({"success": True, "activityId": "LA7Q2ZKM"})
            return FakeResponse({"success": True, "activityId": "LA7Q2ZKM"})

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "out"
            with patch.dict(os.environ, {
                "NOTIFY_DEVICE_ID": "IOFAKE1234567", "NOTIFY_TOKEN": "fakeTOKEN123456",
                "GITHUB_OUTPUT": str(output), "GITHUB_REPOSITORY": "fake/repo",
                "GITHUB_RUN_ID": "1234567",
            }):
                with patch.object(notify.urllib.request, "urlopen", side_effect=respond):
                    def args(action, **overrides):
                        import argparse
                        return argparse.Namespace(
                            action=action, workflow="Deploy", job="release", step="Build",
                            outcome=overrides.get("outcome", "success"),
                            activity_id=overrides.get("activity_id", ""),
                            progress=overrides.get("progress", "25"),
                        )

                    notify.handle(args("start"), "IOFAKE1234567", "fakeTOKEN123456")
                    notify.handle(args("step", activity_id="LA7Q2ZKM"), "IOFAKE1234567", "fakeTOKEN123456")
                    notify.handle(args("end", activity_id="LA7Q2ZKM"), "IOFAKE1234567", "fakeTOKEN123456")

            self.assertIn("activity_id=LA7Q2ZKM", output.read_text())
            self.assertIn("new=1", requests[0].full_url)
            self.assertIn("/live-activity/LA7Q2ZKM?", requests[1].full_url)
            self.assertIn("/notify-json/", requests[2].full_url)
            self.assertEqual(requests[-1].get_method(), "DELETE")
            self.assertEqual(json.loads(requests[-1].data)["keepFor"], 90)
            self.assertIn("progress", json.loads(requests[1].data))
            self.assertEqual(json.loads(requests[2].data)["groupType"], "photointel-1234567")

    def test_successful_step_is_silent_without_live_activity(self):
        import argparse

        args = argparse.Namespace(
            action="step", workflow="🚀 Deploy", job="deploy", step="📥 Checkout repository",
            outcome="success", activity_id="", progress="20",
        )
        with patch.object(notify, "send") as send:
            notify.handle(args, "IOFAKE1234567", "fakeTOKEN123456")
            send.assert_not_called()

    def test_step_failure_push_is_short(self):
        import argparse

        args = argparse.Namespace(
            action="step", workflow="🚀 Deploy", job="deploy",
            step="🗃️ [MIGRATE] Plan or execute protected Neon migration",
            outcome="failure", activity_id="", progress="30",
        )
        with patch.object(notify, "send", return_value={"success": True}) as send:
            notify.handle(args, "IOFAKE1234567", "fakeTOKEN123456")
            self.assertEqual(send.call_count, 1)
            payload = send.call_args.args[3]
            self.assertEqual(payload["title"], "PhotoIntel · Deploy")
            self.assertLessEqual(len(payload["text"]), 35)

    def test_secret_missing_is_disabled_without_network(self):
        with patch.dict(os.environ, {"NOTIFY_DEVICE_ID": "", "NOTIFY_TOKEN": ""}):
            with patch.object(notify.urllib.request, "urlopen", side_effect=AssertionError("network")):
                with patch("sys.argv", ["notify.py", "--action", "step"]):
                    self.assertEqual(notify.main(), 0)

    def test_transport_failure_never_prints_token(self):
        with patch.dict(os.environ, {"NOTIFY_DEVICE_ID": "IOFAKE1234567", "NOTIFY_TOKEN": "secretTOP123456"}):
            with patch.object(notify.urllib.request, "urlopen", side_effect=urllib.error.URLError("secretTOP123456")):
                with patch("sys.argv", ["notify.py", "--action", "step", "--outcome", "failure"]):
                    with patch("sys.stdout", new_callable=io.StringIO) as stdout:
                        self.assertEqual(notify.main(), 0)
                    self.assertNotIn("secretTOP123456", stdout.getvalue())

    def test_all_workflows_notify_after_each_original_step(self):
        total = 0
        for name in WORKFLOWS:
            text = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            # Notification helper steps have their own names and must not recursively notify.
            notifications = re.findall(r'^      - name: "🔔 \[NOTIFY\] ', text, re.M)
            original_count = len([
                line for line in text.splitlines()
                if re.match(r"^      - (?:name:|id:|uses:|run:)", line)
                and not line.startswith('      - name: "🔔 [NOTIFY]')
                and not line.startswith('      - name: "📱 Live')
            ])
            total += original_count
            self.assertEqual(len(notifications), original_count, name)
            self.assertIn("secrets.NOTIFY_DEVICE_ID", text, name)
            self.assertIn("secrets.NOTIFY_TOKEN", text, name)
            self.assertIn("continue-on-error: true", text, name)
            self.assertIn("uses: ./.github/actions/notify", text, name)
        self.assertGreaterEqual(total, 199, "Unexpected loss of observed workflow steps")

    def test_gcp_only_live_activity_lifecycle(self):
        for name in ("gcp-bootstrap.yml", "gcp-deploy.yml"):
            text = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertIn("id: notify_live_start", text)
            self.assertIn("steps.notify_live_start.outputs.activity_id", text)
            self.assertIn("action: start", text)
            self.assertIn("action: end", text)
            self.assertIn("job.status", text)
        for name in set(WORKFLOWS) - {"gcp-bootstrap.yml", "gcp-deploy.yml"}:
            text = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertNotIn("action: start", text)
            self.assertNotIn("action: end", text)


if __name__ == "__main__":
    unittest.main()
