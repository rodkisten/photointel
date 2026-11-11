"""Offline contract tests: media deployment must use safe, explicit CLI commands."""
import unittest

from infra.gcp.media import commands


class MediaCommandsTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "project_id": "photointel",
            "region": "us-central1",
            "repository": "photointel",
            "storage_bucket": "photointel",
        }

    def test_immutable_source_sha_required(self):
        with self.assertRaises(ValueError):
            commands(self.config, "latest")

    def test_jobs_are_private_and_scoped(self):
        result = commands(self.config, "a" * 40)
        self.assertEqual(len(result), 2)
        for command in result:
            self.assertEqual(command[:3], ["run", "jobs", "deploy"])
            self.assertNotIn("allUsers", command)
            self.assertNotIn("--allow-unauthenticated", command)
            self.assertIn("--service-account", command)
            self.assertIn("photointel-media@photointel.iam.gserviceaccount.com", command)
            self.assertEqual(command.count("--update-secrets"), 1)
            self.assertIn("--max-retries", command)


if __name__ == "__main__":
    unittest.main()
