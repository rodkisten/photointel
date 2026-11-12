"""Regression coverage for compact Secret Manager reference parsing."""
import unittest

from infra.gcp.gcp_env import compact_secret_reference


class CompactSecretReferenceTests(unittest.TestCase):
    def test_workflow_secret_with_explicit_version(self):
        self.assertEqual(
            compact_secret_reference("WORKFLOW_SECRET__API_TOKEN", "photointel-api-token@3", "photointel-"),
            ("API_TOKEN", {"name": "photointel-api-token", "version": "3"}),
        )

    def test_workflow_secret_without_version(self):
        self.assertEqual(
            compact_secret_reference("WORKFLOW_SECRET__API_TOKEN", "photointel-api-token", "photointel-"),
            ("API_TOKEN", {"name": "photointel-api-token", "version": "latest"}),
        )

    def test_standard_secret_unchanged(self):
        self.assertEqual(
            compact_secret_reference("SECRET__API_TOKEN", "photointel-api-token@latest", "photointel-"),
            ("API_TOKEN", {"name": "photointel-api-token", "version": "latest"}),
        )


if __name__ == "__main__":
    unittest.main()
