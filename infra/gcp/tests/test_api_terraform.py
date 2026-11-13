"""Regression tests for API/Worker adoption and the single-writer boundary."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from infra.terraform import api_release as api
from infra.terraform import cloudflare_release as cf
from infra.scripts.publish_worker import publish_version


class APIAdoptionTests(unittest.TestCase):
    def test_full_preparation_adopts_api_without_creating_absent_processors(self):
        from infra.gcp.manage import validate, service
        config_path = Path(__file__).parents[1] / "config.example.json"
        config = validate(json.loads(config_path.read_text()))
        config["project_id"] = "photointel"
        config["release_git_sha"] = "a" * 40
        live = service(config)
        live["status"] = {"latestReadyRevisionName": "ready-revision"}
        digest = "us-central1-docker.pkg.dev/photointel/photointel/api@sha256:" + "c" * 64

        def inventory(args, **kwargs):
            if args[:3] == ["run", "services", "describe"]:
                return live
            if args[:3] == ["run", "revisions", "describe"]:
                return {"status": {"imageDigest": digest}}
            if args[:3] == ["run", "services", "get-iam-policy"]:
                return {"bindings": [{"role": "roles/run.invoker", "members": ["allUsers"]}]}
            if args[:3] == ["run", "jobs", "describe"]:
                return None
            raise AssertionError(args)

        with tempfile.TemporaryDirectory() as temp, patch.object(api, "ROOT", Path(temp)), patch.object(api, "lookup", side_effect=inventory), patch.object(api.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")):
            api.prepare(config)
            values = json.loads((Path(temp) / "api-release.auto.tfvars.json").read_text())
            imports = json.loads((Path(temp) / "api-imports.auto.tf.json").read_text())["import"]
        self.assertEqual(values["api_definition"]["image"], digest)
        self.assertEqual(values["processing_jobs"], {})
        self.assertEqual(len(imports), 1)
        self.assertEqual(imports[0]["to"], "google_cloud_run_v2_service.api[0]")
        self.assertTrue(values["api_definition"]["startup_probe"]["httpGet"]["path"].startswith("/health/"))

    def test_environment_uses_references_and_rejects_inline_credentials(self):
        entries = [{"name": "DATABASE_URL", "valueFrom": {"secretKeyRef": {"name": "photointel-db", "key": "2"}}}, {"name": "FEATURE", "value": "yes"}]
        self.assertEqual(api.env_spec(entries)[0], {"name": "DATABASE_URL", "secret": "photointel-db", "version": "2"})
        for name in ("DATABASE_URL", "TELEGRAM_NOTIFICATION_API_TOKEN", "CUSTOM_PASSWORD"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                api.env_spec([{"name": name, "value": "private"}])

    def test_live_custom_configuration_and_extra_env_survive(self):
        desired = {"command": ["python"], "args": ["entry.py"], "env": [{"name": "KNOWN", "value": "updated"}], "resources": {"limits": {"cpu": "1000m", "memory": "1Gi"}}}
        current = {"command": ["custom"], "args": ["run"], "env": [{"name": "EXTRA", "value": "preserved"}, {"name": "KNOWN", "value": "old"}], "resources": {"limits": {"cpu": "2000m", "memory": "2Gi"}}}
        spec = api.container_spec(desired, current, "image@sha256:abc")
        self.assertEqual(spec["command"], ["custom"])
        self.assertEqual(spec["limits"], {"cpu": "2", "memory": "2Gi"})
        self.assertEqual({e["name"]: e["value"] for e in spec["env"]}, {"KNOWN": "updated", "EXTRA": "preserved"})
        with self.assertRaises(ValueError):
            api.container_spec(desired, {**current, "volumeMounts": [{"name": "custom"}]}, "image")

    def test_invokers_preserve_conditions_and_do_not_invent_public_access(self):
        condition = {"title": "limited", "expression": "request.time < timestamp('2030-01-01T00:00:00Z')"}
        policy = {"bindings": [{"role": "roles/run.invoker", "members": ["serviceAccount:caller@example.com"], "condition": condition}, {"role": "roles/run.admin", "members": ["user:admin@example.com"]}]}
        adopted = list(api.invokers(policy, name="api").values())
        self.assertEqual(adopted, [{"member": "serviceAccount:caller@example.com", "job": "api", "condition": condition}])

    def test_registry_lookup_failure_does_not_build_or_deploy(self):
        with patch.object(api, "cloud_run", return_value=subprocess.CompletedProcess([], 1, "", "PERMISSION_DENIED")) as run:
            with self.assertRaisesRegex(RuntimeError, "inventory"):
                api.image_digest("us-central1-docker.pkg.dev/photointel/photointel/api:" + "a" * 40, "us-central1")
        self.assertEqual(run.call_args.args[0][:3], ["artifacts", "docker", "images"])


class CloudflareAdoptionTests(unittest.TestCase):
    def test_new_backend_is_distinct_from_a_state_access_failure(self):
        with patch.object(cf.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "No state file was found!")):
            self.assertEqual(cf.state_addresses(), set())
        with patch.object(cf.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "403 Permission denied")):
            with self.assertRaisesRegex(RuntimeError, "refusing adoption"):
                cf.state_addresses()

    def test_schema_filter_never_copies_computed_ids_or_scim_credentials(self):
        schema = {"block": {"attributes": {"name": {"required": True}, "id": {"computed": True}}}}
        self.assertEqual(cf.supported_metadata(schema, {"id": "uuid", "name": "worker", "unrelated": "x"}), {"name": "worker"})
        with self.assertRaisesRegex(ValueError, "SCIM"):
            cf.supported_metadata(schema, {"scim_config": {"authentication": {"password": "private"}}})

    def test_generated_resources_are_protected_and_data_is_not_evaluated_as_code(self):
        inventory = {key: {} for key in cf.TYPES}
        inventory["domains"]["photos.migos.club"] = {"id": "domain-id", "account_id": "a" * 32, "hostname": "photos.migos.club", "service": "${untrusted}"}
        schemas = {kind: {"block": {"attributes": {"account_id": {"required": True}, "hostname": {"optional": True}, "service": {"optional": True}}}} for kind in cf.TYPES.values()}
        declarations, variables = cf.generated_configuration(inventory, schemas, set())
        self.assertNotIn("${untrusted}", json.dumps(declarations))
        self.assertEqual(variables["cf_inventory"]["domains"]["photos.migos.club"]["service"], "${untrusted}")
        self.assertEqual(len(declarations["import"]), 1)
        for groups in declarations["resource"].values():
            self.assertTrue(next(iter(groups.values()))["lifecycle"]["prevent_destroy"])

    def test_worker_publication_only_uses_version_commands(self):
        with patch("infra.scripts.publish_worker.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            publish_version(Path("config.json"), cwd=Path("."), env={"GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "1"})
        self.assertEqual([c.args[0][3:5] for c in run.call_args_list], [["versions", "upload"], ["versions", "deploy"]])
        self.assertTrue(all("triggers" not in c.args[0] for c in run.call_args_list))


if __name__ == "__main__":
    unittest.main()
