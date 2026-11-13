"""Offline contract tests: media deployment must use safe, explicit CLI commands."""
import unittest
import subprocess
from unittest.mock import patch

from infra.gcp.media import commands, execute, validate_job
from infra.gcp.cloud_cli import classify


class MediaCommandsTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "project_id": "photointel",
            "region": "us-central1",
            "repository": "photointel",
            "storage_bucket": "photointel",
        }

    def test_error_categories_and_safe_provider_evidence(self):
        cases = [
            ("PERMISSION_DENIED: iam.serviceAccounts.actAs on service account photointel-media@photointel.iam.gserviceaccount.com", "SERVICE_ACCOUNT_ACT_AS"),
            ("PERMISSION_DENIED: run.jobs.create", "CLOUD_RUN_JOB_IAM"),
            ("PERMISSION_DENIED: run.jobs.update", "CLOUD_RUN_JOB_IAM"),
            ("PERMISSION_DENIED: secretmanager.versions.access", "SECRET_MANAGER"),
            ("PERMISSION_DENIED: artifactregistry.repositories.downloadArtifacts", "ARTIFACT_REGISTRY"),
            ("NOT_FOUND: service account does not exist", "SERVICE_ACCOUNT_NOT_FOUND"),
            ("PERMISSION_DENIED: IAM condition not satisfied", "IAM_CONDITION"),
            ("PERMISSION_DENIED: blocked by deny policy", "IAM_DENY"),
            ("INVALID_ARGUMENT: invalid configuration for memory", "JOB_CONFIGURATION"),
        ]
        for message, category in cases:
            with self.subTest(category=category):
                failure = classify(message + " Bearer PRIVATE_TOKEN secret=PRIVATE_VALUE ::error::injected")
                self.assertEqual(failure.category, category)
                self.assertTrue(failure.hint)
                self.assertNotIn("PRIVATE", repr(failure))
                self.assertNotIn("::error::", repr(failure))
        failure = classify(cases[0][0] + " (gcloud.run.jobs.deploy)")
        self.assertEqual(failure.permissions, ("iam.serviceAccounts.actAs",))
        self.assertEqual(failure.evidence, ("photointel-media@photointel.iam.gserviceaccount.com",))
        self.assertIn("runtime", failure.hint)
        self.assertNotIn("build service account", failure.hint)

    def test_legacy_apply_cannot_bypass_terraform_ownership(self):
        with patch("infra.gcp.media.cloud_run") as run:
            with self.assertRaisesRegex(RuntimeError, "owned by Terraform"):
                execute(self.config, "a" * 40, apply=True)
            run.assert_not_called()

    def test_deployed_job_checks_configuration_and_readiness(self):
        from infra.gcp.media import REQUIRED_SECRET_ENV
        import copy
        for kind in ("image", "video"):
            task = {
                "serviceAccountName": "photointel-media@photointel.iam.gserviceaccount.com",
                "maxRetries": 0, "timeoutSeconds": "1800" if kind == "video" else "600",
                "containers": [{
                    "image": f"us-central1-docker.pkg.dev/photointel/photointel/media-{kind}:" + "a" * 40,
                    "resources": {"limits": {"cpu": "2" if kind == "video" else "1", "memory": "2Gi" if kind == "video" else "1Gi"}},
                    "env": [{"name": "R2_BUCKET", "value": "photointel"}] + [
                        {"name": name, "valueFrom": {"secretKeyRef": {"name": secret, "key": "latest"}}}
                        for name, secret in REQUIRED_SECRET_ENV
                    ],
                }],
            }
            job = {"spec": {"template": {"spec": {"template": {"spec": task}}}}, "status": {"conditions": [{"type": "Ready", "status": "True"}]}}
            validate_job(job, self.config, kind, "a" * 40)
            for field, value in (("serviceAccountName", "wrong"), ("maxRetries", 1), ("timeoutSeconds", "5")):
                changed = copy.deepcopy(job)
                changed["spec"]["template"]["spec"]["template"]["spec"][field] = value
                with self.subTest(kind=kind, field=field), self.assertRaises(RuntimeError):
                    validate_job(changed, self.config, kind, "a" * 40)
            task["containers"][0]["env"] = []
            with self.assertRaisesRegex(RuntimeError, "secret reference"):
                validate_job(job, self.config, kind, "a" * 40)

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
