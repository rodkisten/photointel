"""Offline tests for compact release selection and build/deploy boundaries."""
import os
import subprocess
import unittest
from unittest.mock import patch

from infra.terraform import release_console as release


class ReleaseConsoleTests(unittest.TestCase):
    def test_latest_media_requires_both_images_from_the_same_source(self):
        catalogs = [{"a" * 40: "2026-01-01", "b" * 40: "2026-02-01"}, {"a" * 40: "2026-01-01"}]
        self.assertEqual(release.newest_common(catalogs), "a" * 40)
        with self.assertRaises(RuntimeError):
            release.newest_common([{"a" * 40: "date"}, {"b" * 40: "date"}])

    def test_published_deploy_does_not_build(self):
        env = {"ACTION": "deploy", "TARGET": "api", "SOURCE": "last", "REQUESTED_SHA": "", "CONFIRM": "true", "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "b" * 40}
        with patch.dict(os.environ, env, clear=True), patch.object(release, "image_catalog", return_value={"a" * 40: "date"}), patch.object(release, "validate_source"), patch.object(release, "database_gate"), patch.object(release, "build_images") as build, patch.object(release, "terraform_dispatch") as deploy:
            release.main()
            build.assert_not_called()
            deploy.assert_called_once()
            self.assertEqual(os.environ["API_SHA"], "a" * 40)

    def test_blank_sha_main_builds_once_then_deploys(self):
        env = {"ACTION": "build-and-deploy", "TARGET": "media", "SOURCE": "main", "CONFIRM": "true", "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "b" * 40}
        with patch.dict(os.environ, env, clear=True), patch.object(release, "image_catalog", side_effect=[{}, {}, {"b" * 40: "date"}, {"b" * 40: "date"}]), patch.object(release, "validate_source"), patch.object(release, "database_gate"), patch.object(release, "build_images") as build, patch.object(release, "terraform_dispatch") as deploy:
            release.main()
            build.assert_called_once_with("media", "b" * 40)
            deploy.assert_called_once()
            self.assertEqual(os.environ["IMAGE_SHA"], "b" * 40)

    def test_build_failure_blocks_deploy(self):
        env = {"ACTION": "deploy", "TARGET": "api", "SOURCE": "main", "CONFIRM": "true", "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "b" * 40}
        with patch.dict(os.environ, env, clear=True), patch.object(release, "image_catalog", return_value={}), patch.object(release, "validate_source"), patch.object(release, "database_gate"), patch.object(release, "build_images", side_effect=RuntimeError("build failed")), patch.object(release, "terraform_dispatch") as deploy:
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                release.main()
            deploy.assert_not_called()

    def test_plan_never_builds(self):
        env = {"ACTION": "plan", "TARGET": "api", "SOURCE": "main", "CONFIRM": "false", "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "b" * 40}
        with patch.dict(os.environ, env, clear=True), patch.object(release, "image_catalog", return_value={}), patch.object(release, "validate_source"), patch.object(release, "database_gate"), patch.object(release, "build_images") as build, patch.object(release, "terraform_dispatch"):
            release.main()
            build.assert_not_called()
            self.assertEqual(os.environ["API_SHA"], "")


if __name__ == "__main__":
    unittest.main()
