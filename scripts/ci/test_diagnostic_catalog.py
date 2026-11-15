"""Contract tests for the shared CI / Manage GCP diagnostic catalog."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "apps/manage/src/gcp-diagnostic-catalog.json"


class DiagnosticCatalogTests(unittest.TestCase):
    def test_catalog_has_safe_console_routes_and_complete_entries(self):
        entries = json.loads(CATALOG.read_text(encoding="utf-8"))
        self.assertIn("PERMISSION_DENIED", entries)
        self.assertIn("AUTHENTICATION", entries)
        self.assertIn("QUOTA", entries)
        for code, entry in entries.items():
            with self.subTest(code=code):
                self.assertRegex(code, r"^[A-Z_]+$")
                self.assertTrue(all(isinstance(entry.get(key), str) and entry[key].strip()
                                    for key in ("title", "hint", "route")))
                self.assertRegex(entry["route"], r"^[a-z0-9/-]+$")
                self.assertNotIn("..", entry["route"])

    def test_cli_uses_same_catalog_route(self):
        entries = json.loads(CATALOG.read_text(encoding="utf-8"))
        samples = {
            "AUTHENTICATION": "UNAUTHENTICATED: no active account",
            "QUOTA": "RESOURCE_EXHAUSTED: quota exceeded",
            "SECRET_MANAGER": "PERMISSION_DENIED: Secret Manager secretmanager.versions.access",
            "ARTIFACT_REGISTRY": "PERMISSION_DENIED: artifactregistry.repositories.downloadArtifacts",
            "SERVICE_ACCOUNT_NOT_FOUND": "NOT_FOUND: service account does not exist",
            "CLOUD_RUN_JOB_IAM": "PERMISSION_DENIED: run.jobs.update",
            "IAM_DENY": "PERMISSION_DENIED: deny policy",
            "IAM_CONDITION": "PERMISSION_DENIED: condition not satisfied",
        }
        for category, log in samples.items():
            with self.subTest(category=category), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "gcloud.log"
                path.write_text(log, encoding="utf-8")
                result = subprocess.run(
                    [sys.executable, "-m", "scripts.ci.gcloud_diagnostics", str(path), "photointel"],
                    cwd=ROOT, text=True, capture_output=True, check=True,
                )
                self.assertIn(entries[category]["title"], result.stdout)
                self.assertIn("/" + entries[category]["route"] + "?project=photointel", result.stdout)


if __name__ == "__main__":
    unittest.main()
