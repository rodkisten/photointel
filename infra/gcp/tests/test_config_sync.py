"""Offline, no-cloud contract checks for runtime-only configuration updates."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

GCP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GCP))
spec = importlib.util.spec_from_file_location("config_sync", GCP / "config_sync.py")
assert spec is not None and spec.loader is not None
config_sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config_sync)


class ConfigSyncTests(unittest.TestCase):
    def test_live_image_is_reused_from_running_revision(self):
        live = {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [{
                            "image": "us-central1-docker.pkg.dev/photointel/photointel/api:" + "a" * 40,
                            "env": [{"name": "RELEASE_GIT_SHA", "value": "a" * 40}],
                        }],
                    },
                },
            },
        }
        with patch.object(config_sync, "gcloud", return_value=json.dumps(live)) as fake:
            image, sha = config_sync.live_image_and_sha("services", "photointel-api", "us-central1")
        self.assertEqual(image.rsplit(":", 1)[-1], "a" * 40)
        self.assertEqual(sha, "a" * 40)
        self.assertIn("describe", fake.call_args.args[0])

    def test_rejects_cross_project_running_image(self):
        live = {
            "spec": {"template": {"spec": {"containers": [
                {"image": "us-central1-docker.pkg.dev/another/photointel/api:latest",
                 "env": [{"name": "RELEASE_GIT_SHA", "value": "a" * 40}]},
            ]}}},
        }
        with patch.object(config_sync, "gcloud", return_value=json.dumps(live)):
            with self.assertRaises(config_sync.ConfigurationSyncError):
                config_sync.live_image_and_sha("services", "photointel-api", "us-central1")

    def test_patches_only_image_and_release_sha(self):
        with tempfile.TemporaryDirectory() as dirname:
            file = Path(dirname) / "photointel-api.json"
            file.write_text(json.dumps({
                "spec": {"template": {"spec": {"containers": [{
                    "image": "unbuilt:image", "env": [
                        {"name": "RELEASE_GIT_SHA", "value": "b" * 40},
                        {"name": "TELEGRAM_NOTIFICATION_CHAT_ID", "value": "-1001234"},
                    ],
                }]}}},
            }))
            image = "us-central1-docker.pkg.dev/photointel/photointel/api:" + "a" * 40
            config_sync.patch(file, image, "a" * 40, kind="service")
            after = json.loads(file.read_text())["spec"]["template"]["spec"]["containers"][0]
            self.assertEqual(after["image"], image)
            self.assertEqual(after["env"][0]["value"], "a" * 40)
            self.assertEqual(after["env"][1]["value"], "-1001234")


if __name__ == "__main__":
    unittest.main()
