"""Regression: deploy-time generated GCP files cannot dirty the release checkout.

The gcp-config composite action writes config.local.json and renders 6 resource
descriptors before release.sh build invokes release-manifest.py. The manifest
refuses a dirty Git working tree. These files are private artifacts, not source.
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GENERATED = (
    "infra/gcp/config.local.json",
    "infra/gcp/rendered/photointel-api.json",
    "infra/gcp/rendered/photointel-worker.json",
    "infra/gcp/state/runtime.json",
)


class BuildWorkspaceTests(unittest.TestCase):
    def test_generated_gcp_files_are_git_ignored(self) -> None:
        for pathname in GENERATED:
            with self.subTest(path=pathname):
                result = subprocess.run(
                    ["git", "check-ignore", "-q", "--", pathname],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    f"{pathname} must be ignored to keep release-manifest.py clean",
                )

    def test_secret_config_is_excluded_from_cloud_build_upload(self) -> None:
        patterns = (
            ROOT / "infra/gcp/build.gcloudignore"
        ).read_text(encoding="utf-8").splitlines()
        self.assertIn("infra/gcp/config.local.json", patterns)
        self.assertIn("infra/gcp/rendered/**", patterns)
        self.assertIn("infra/gcp/state/**", patterns)


if __name__ == "__main__":
    unittest.main()
