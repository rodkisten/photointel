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
import urllib.parse
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("notify_adapter", ROOT / "infra/notify/notify.py")
assert SPEC and SPEC.loader
notify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notify)

WORKFLOWS = (
    "bootstrap-validation.yml", "ci.yml", "compose-validation.yml",
    "container-architectures.yml", "deploy-worker.yml", "gcp-bootstrap.yml",
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
            self.assertEqual(json.loads(requests[-1].data)["keepFor"], 60)
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

    def test_workflow_titles_are_distinct_not_all_ci(self):
        names = [
            "🧪 CI", "🐳 Compose", "☁️ GCP Check", "🍎 iCloud Validation",
            "🧱 Setup GCP", "🌐 Cloudflare Worker", "📱 GCP Terminal",
            "🗃️ Migrate Neon", "📦 ZIP Patch", "🧠 CPU Models",
        ]
        labels = [notify.short_workflow(name) for name in names]
        self.assertEqual(len(labels), len(set(labels)))
        self.assertEqual(labels[0], "PhotoIntel · CI")
        self.assertEqual(notify.short_workflow("Custom diagnostics"),
                         "PhotoIntel · Custom diagnostics")

    def test_no_success_push_without_started_activity(self):
        import argparse
        args = argparse.Namespace(action="end", workflow="🌐 Cloudflare Worker",
                                  job="deploy", outcome="success", activity_id="", total="1")
        with patch.object(notify, "send") as send:
            notify.handle(args, "IOFAKE1234567", "fakeTOKEN123456")
            send.assert_not_called()

    def test_api_notify_source_and_deployment_contract(self):
        import ast
        source = (ROOT / "apps/api/src/photointel/services/job_notify.py").read_text()
        ast.parse(source)
        self.assertIn("NOTIFY_JOB_EVENTS_ENABLED", source)
        self.assertIn("with_for_update=True", source)
        self.assertIn("scope_for", source)
        self.assertIn("send_push", source)
        self.assertIn("drain_job_notifications", source)
        management = (ROOT / "infra/gcp/manage.py").read_text()
        self.assertIn('"NOTIFY_DEVICE_ID"', management)
        self.assertIn('"NOTIFY_TOKEN"', management)
        self.assertIn('"NOTIFY_JOB_EVENTS_ENABLED"', management)
        self.assertIn('mode != "migrate"', management)

    def test_only_strategic_workflows_send_notify(self):
        strategic = {"gcp-deploy.yml", "gcp-bootstrap.yml", "deploy-worker.yml", "zip.yml"}
        for name in WORKFLOWS:
            source = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertEqual("uses: ./.github/actions/notify" in source, name in strategic, name)
        for name in ("gcp-deploy.yml", "gcp-bootstrap.yml"):
            source = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8")
            self.assertIn("action: start", source)
            self.assertIn("action: end", source)
            self.assertIn("github-token: ${{ github.token }}", source)
            self.assertIn("step-index:", source)
            self.assertNotIn("endsIn:", source)
            self.assertNotIn("🔔 [NOTIFY]", source)

    def test_segmented_stages_and_open_button_without_countdown(self):
        import argparse

        args = argparse.Namespace(action="start", workflow="🚀 Deploy", job="deploy",
                                  step="", outcome="", activity_id="", progress="",
                                  total="4", completed="0")
        with (
            patch.object(notify, "send", return_value={"success": True, "activityId": "LA7Q2ZKM"}) as sent,
            patch.dict(os.environ, {"GITHUB_REPOSITORY": "rodkisten/photointel",
                                    "GITHUB_RUN_ID": "123456"}),
            patch.object(notify, "append_output"),
        ):
            notify.handle(args, "IOFAKE1234567", "fakeTOKEN123456")
        payload = sent.call_args.args[3]
        self.assertEqual((payload["steps"], payload["step"]), (4, 0))
        self.assertEqual(payload["trailing"], "0/4")
        self.assertNotIn("endsIn", payload)
        self.assertTrue(payload["button"]["open"])

    def test_in_progress_phase_opens_exact_step(self):
        import argparse

        args = argparse.Namespace(action="step", workflow="🚀 Deploy", job="deploy",
                                  step="🚀 API", label="🚀 API", step_index="15",
                                  outcome="running", activity_id="LA7Q2ZKM",
                                  total="4", completed="2",
                                  project="photointel", region="us-central1")
        with (
            patch.object(notify, "send", return_value={"success": True}) as sent,
            patch.object(notify, "github_step_link",
                return_value="https://github.com/rodkisten/photointel/actions/runs/123/job/9#step:15:1"),
        ):
            notify.handle(args, "IOFAKE1234567", "fakeTOKEN123456")
        self.assertEqual(sent.call_count, 1)
        payload = sent.call_args.args[3]
        self.assertEqual(payload["step"], 2)
        self.assertEqual(payload["trailing"], "2/4")
        self.assertEqual(payload["button"]["title"], "Ver step")
        self.assertIn("#step:15:1", payload["button"]["url"])
        self.assertNotIn("endsIn", payload)

    def test_job_api_matches_step_or_uses_step_index_when_pending(self):
        import io

        job = {"id": 987654, "name": "🚀 deploy",
               "steps": [{"name": "📦 Jobs", "number": 12}]}
        class Response:
            def __enter__(self):
                return io.BytesIO(json.dumps({"jobs": [job]}).encode())
            def __exit__(self, *_args):
                return False

        with (
            patch.dict(os.environ, {
                "GITHUB_REPOSITORY": "rodkisten/photointel",
                "GITHUB_RUN_ID": "123", "GITHUB_API_TOKEN": "GITHUB_PRIVATE_FAKE",
            }),
            patch.object(notify.urllib.request, "urlopen", return_value=Response()) as call,
        ):
            found = notify.github_step_link("📦 Jobs", "deploy", "17")
            pending = notify.github_step_link("🗃 Neon", "deploy", "17")
            self.assertEqual(found, "https://github.com/rodkisten/photointel/actions/runs/123/job/987654#step:12:1")
            self.assertEqual(pending, "https://github.com/rodkisten/photointel/actions/runs/123/job/987654#step:17:1")
            request = call.call_args.args[0]
            self.assertIn("GITHUB_PRIVATE_FAKE", request.get_header("Authorization"))
            self.assertNotIn("GITHUB_PRIVATE_FAKE", request.full_url)

    def test_gcp_error_button_only_for_cloud_phases(self):
        import argparse

        def failure(step):
            return argparse.Namespace(
                action="step", workflow="🚀 Deploy", job="deploy", step=step,
                label=step, step_index="12", outcome="failure",
                activity_id="LA7Q2ZKM", total="4", completed="1",
                project="photointel", region="us-central1",
            )

        with (
            patch.object(notify, "send", return_value={"success": True}) as sent,
            patch.object(notify, "github_step_link",
                return_value="https://github.com/rodkisten/photointel/actions/runs/123"),
        ):
            notify.handle(failure("🚀 API"), "IOFAKE1234567", "fakeTOKEN123456")
            payload = sent.call_args_list[-1].args[3]
            self.assertEqual(payload["button"]["title"], "Logs GCP")
            self.assertIn("photointel-api/logs", payload["button"]["url"])
            sent.reset_mock()
            notify.handle(failure("🗃 Neon"), "IOFAKE1234567", "fakeTOKEN123456")
            payload = sent.call_args_list[-1].args[3]
            self.assertEqual(payload["button"]["title"], "Ver step")

    def test_job_failure_links_to_filtered_cloud_logging(self):
        url = notify.gcp_failure_url("📦 Jobs", "photointel", "us-central1")
        self.assertIn("/logs/query;query=", url)
        self.assertIn("cloud_run_job", urllib.parse.unquote(url))
        self.assertNotIn("token=", url)

    def test_failure_end_preserves_previous_completed_stages(self):
        import argparse

        args = argparse.Namespace(action="end", workflow="🚀 Deploy", job="deploy",
                                  outcome="failure", activity_id="LA7Q2ZKM",
                                  total="4", completed="0")
        with patch.object(notify, "send", return_value={"success": True}) as sent:
            notify.handle(args, "IOFAKE1234567", "fakeTOKEN123456")
        payload = sent.call_args.args[3]
        self.assertEqual(payload["status"], "failed")
        self.assertNotIn("steps", payload)
        self.assertEqual(payload["endsIn"], None)
        self.assertEqual(payload["keepFor"], 60)


if __name__ == "__main__":
    unittest.main()
