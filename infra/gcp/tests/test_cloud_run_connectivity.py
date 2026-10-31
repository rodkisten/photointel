"""Pure offline tests for read-only Cloud Run API connectivity diagnosis."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "cloud_run_connectivity", ROOT / "infra/gcp/diagnose_api_connectivity.py"
)
assert SPEC and SPEC.loader
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)


class CloudRunConnectivityTests(unittest.TestCase):
    def test_cloud_run_ready_health_passes(self):
        data = {
            "status": {
                "url": "https://photointel-api-799387180206.us-central1.run.app",
                "latestCreatedRevisionName": "photointel-api-001",
                "latestReadyRevisionName": "photointel-api-001",
                "conditions": [{"type": "Ready", "status": "True"}],
                "traffic": [{"percent": 100}],
            }
        }
        details = app.safe_service_status(data)
        self.assertEqual(details["ready"], "True")
        self.assertEqual(details["traffic_percent"], 100)
        self.assertEqual(details["url"], data["status"]["url"])
        self.assertEqual(app.assess(details["ready"], 200, 200), [])

    def test_bad_service_url_not_probed(self):
        for bad in (
            "https://evil.invalid",
            "http://photointel-api-123.a.run.app",
            "https://abc.run.app:444",
            "https://abc.run.app/steal",
            "https://user:password@abc.run.app",
        ):
            with self.subTest(bad=bad):
                self.assertIsNone(
                    app.safe_service_status({"status": {"url": bad}})["url"]
                )

    def test_readiness_dependency_failure_is_distinct_from_liveness(self):
        problems = app.assess("True", 200, 503)
        self.assertEqual(len(problems), 1)
        self.assertIn("Neon PostgreSQL", problems[0])
        self.assertIn("Cloudflare R2", problems[0])
        self.assertIn("Cloud Run Invoker IAM", app.assess("True", 403, 403)[0])
        self.assertTrue(app.assess("False", 200, 200))
        self.assertIn("unreachable", app.assess("True", None, None)[0])

    def test_gcloud_failure_never_emits_raw_secret_bearing_stderr(self):
        class Failure:
            returncode = 1
            stdout = ""
            stderr = "VERY_PRIVATE"
        with patch.object(app.subprocess, "run", return_value=Failure()):
            with self.assertRaises(RuntimeError) as raised:
                app.service_details("photointel", "us-central1")
        self.assertNotIn("VERY_PRIVATE", str(raised.exception))

    def test_healthy_probe_returns_only_status_not_body(self):
        class Response:
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return None
        with patch.object(app.urllib.request, "urlopen", return_value=Response()) as get:
            result = app.probe("https://abc.run.app", "/health/live")
        self.assertEqual(result, 200)
        self.assertEqual(get.call_args.kwargs["timeout"], app.TIMEOUT)

    def test_workflow_reuses_one_production_config_and_never_mutates_gcp(self):
        path = ROOT / ".github/workflows/gcp-health.yml"
        data = path.read_text()
        self.assertIn("workflow_dispatch:", data)
        self.assertIn("environment: production", data)
        self.assertIn("vars.GCP_CONFIG_ENV", data)
        self.assertIn("id-token: write", data)
        self.assertIn("diagnose_api_connectivity.py", data)
        self.assertIn("diagnose_startup.py", data)
        self.assertEqual(data.count("uses: ./.github/actions/gcp-config"), 2)
        self.assertIn("mode: cleanup", data)
        self.assertNotIn("gcloud run deploy", data)
        self.assertNotIn("gcloud run services replace", data)


if __name__ == "__main__":
    unittest.main()
