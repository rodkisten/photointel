"""Offline regression tests for read-only release image and GCP preflight checks."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "gcp_release_image", ROOT / "infra/gcp/release_image.py"
)
assert SPEC and SPEC.loader
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

SHA = "a" * 40
DIGEST = "sha256:" + "b" * 64
PROJECT = "photointel"


class ImageChecksTests(unittest.TestCase):
    def test_absent_image_yields_cache_miss(self) -> None:
        self.assertIsNone(release.parse_release_digest("[]", SHA))

    def test_valid_sha_tag_resolves_exact_immutable_digest(self) -> None:
        listing = json.dumps([
            {"tags": ["other"], "version": "sha256:" + "c" * 64},
            {"tags": ["extra", SHA], "version": DIGEST},
        ])
        self.assertEqual(release.parse_release_digest(listing, SHA), DIGEST)

    def test_rejects_invalid_and_ambiguous_responses(self) -> None:
        cases = (
            ("{}", SHA),
            ("not json", SHA),
            (json.dumps([{"tags": [SHA], "version": "latest"}]), SHA),
            (json.dumps([{"tags": [SHA], "version": DIGEST}] * 2), SHA),
            ("[]", "short"),
        )
        for listing, sha in cases:
            with self.subTest(listing=listing, sha=sha):
                with self.assertRaises(release.ReleaseCheckError):
                    release.parse_release_digest(listing, sha)

    def test_project_mismatch_fails_before_cloud_access(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            location = Path(directory) / "config.json"
            location.write_text(json.dumps({"project_id": PROJECT}), encoding="utf-8")
            with self.assertRaises(release.ReleaseCheckError):
                release.config_for_project("wrong-project", location)

    def test_missing_image_is_distinct_from_permission_denial(self) -> None:
        config = {
            "region": "us-central1", "project_id": PROJECT, "repository": "photointel",
        }
        with patch.object(
            release, "gcloud", side_effect=release.ReleaseCheckError("NOT_FOUND: absent")
        ):
            self.assertIsNone(release.lookup_digest(PROJECT, config, SHA))
        with patch.object(
            release, "gcloud", side_effect=release.ReleaseCheckError("PERMISSION_DENIED")
        ):
            with self.assertRaises(release.ReleaseCheckError):
                release.lookup_digest(PROJECT, config, SHA)

    def test_preflight_validates_repository_format(self) -> None:
        config = {"region": "us-central1", "repository": "photointel"}
        responses = [
            "deployer@example.com",
            "cloudbuild.googleapis.com\nrun.googleapis.com",
            "",
            "",
            "DOCKER",
        ]
        with patch.object(release, "gcloud", side_effect=responses) as mocked:
            release.preflight(PROJECT, config)
            self.assertEqual(mocked.call_count, 5)
        with patch.object(release, "gcloud", side_effect=responses[:-1] + ["MAVEN"]):
            with self.assertRaises(release.ReleaseCheckError):
                release.preflight(PROJECT, config)

    def test_cache_writes_skip_output_and_verify_fails_closed(self) -> None:
        config = {"project_id": PROJECT, "region": "us-central1", "repository": "photointel"}
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            output = Path(directory) / "output"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            with patch.dict(
                "os.environ", {"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": ""}
            ):
                with patch.object(release, "lookup_digest", return_value=DIGEST):
                    with patch(
                        "sys.argv",
                        [
                            "release_image.py", "cache", "--project", PROJECT,
                            "--sha", SHA, "--config", str(config_path),
                        ],
                    ):
                        self.assertEqual(release.main(), 0)
            self.assertIn("skip=true", output.read_text(encoding="utf-8"))
            with patch.object(release, "lookup_digest", return_value=None):
                with patch(
                    "sys.argv",
                    [
                        "release_image.py", "verify", "--project", PROJECT,
                        "--sha", SHA, "--config", str(config_path),
                    ],
                ):
                    self.assertEqual(release.main(), 1)


if __name__ == "__main__":
    unittest.main()
