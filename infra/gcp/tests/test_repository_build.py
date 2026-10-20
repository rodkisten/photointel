"""Repository builds identify the source without deploying or trusting local state."""

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "cloud_build_source", ROOT / "infra/gcp/build_source_manifest.py"
)
assert SPEC and SPEC.loader
source = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source)


class RepositoryBuildTests(unittest.TestCase):
    def test_exported_source_needs_no_git_or_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (
                "pyproject.toml",
                "packages/configuration/model-pins.json",
                "infra/scripts/release-manifest.py",
            ):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            shutil.copytree(
                ROOT / "infra/migrations/versions", root / "infra/migrations/versions"
            )
            manifest = source.build(root, "a" * 40, "main", "synthetic-build-1")
            self.assertFalse((root / ".git").exists())
            self.assertEqual(manifest["git_sha"], "a" * 40)
            self.assertEqual(
                manifest["database_migration_head"], "0007_model_preprocessing"
            )
            self.assertEqual(manifest["validation_status"], "unverified")
            self.assertEqual(manifest["test_results"], [])
            self.assertIsNone(manifest["container_digest"])
            self.assertIsNone(manifest["modal_deployment_id"])
            # A private config cannot affect or enter the public provenance hash.
            (root / "infra/gcp").mkdir(parents=True)
            (root / "infra/gcp/config.local.json").write_text('{"secret":"synthetic"}')
            repeated = source.build(root, "a" * 40, "main", "synthetic-build-1")
            self.assertEqual(
                manifest["infrastructure_hash"], repeated["infrastructure_hash"]
            )

    def test_missing_or_forged_source_identity_is_rejected(self):
        for sha in ("", "a" * 7, "latest", "a" * 40 + "\n", "G" * 40):
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                source.build(ROOT, sha, "main", "synthetic-build-1")

    def test_repository_build_cannot_update_runtime_or_dispatch_jobs(self):
        pipeline = (ROOT / "cloudbuild.yaml").read_text()
        self.assertIn("--file=infra/docker/api.Dockerfile", pipeline)
        self.assertIn("SOURCE_GIT_SHA=$COMMIT_SHA", pipeline)
        self.assertIn("python infra/gcp/build_source_manifest.py", pipeline)
        self.assertIn("      - .\n", pipeline)
        for unsafe in ("gcloud run", "_DEPLOY_API:", "_UPDATE_JOBS:", "jobs execute"):
            self.assertNotIn(unsafe, pipeline)

    def test_local_ca_is_transient_and_cloud_builder_stays_classic(self):
        classic = (ROOT / "infra/docker/api.Dockerfile").read_text()
        local = (ROOT / "infra/docker/api.buildkit.Dockerfile").read_text()
        compose = (ROOT / "infra/docker/compose.dev.yml").read_text()
        self.assertNotIn("RUN --mount=", classic)
        self.assertIn("dockerfile: infra/docker/api.buildkit.Dockerfile", compose)
        self.assertIn("type=secret,id=build_ca", local)
        self.assertIn("SSL_CERT_FILE=/run/secrets/build_ca", local)
        self.assertNotIn("--allow-insecure", local)
        classic_images = [
            line for line in classic.splitlines() if line.startswith("FROM ")
        ]
        local_images = [line for line in local.splitlines() if line.startswith("FROM ")]
        self.assertEqual(classic_images, local_images)


if __name__ == "__main__":
    unittest.main()
