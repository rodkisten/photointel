"""GCP_CONFIG_ENV single-var JSON/dotenv compatibility and secret-ref policy."""

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra/gcp"))
SPEC = importlib.util.spec_from_file_location("gcp_env", ROOT / "infra/gcp/gcp-env.py")
assert SPEC and SPEC.loader
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)

DEPLOY_WIF = "projects/123456789/locations/global/workloadIdentityPools/github/providers/deploy"
BOOTSTRAP_WIF = "projects/123456789/locations/global/workloadIdentityPools/github-bootstrap/providers/admin"
DEPLOY_SA = "photointel-deployer@photointel.iam.gserviceaccount.com"
ADMIN_SA = "photointel-bootstrap@photointel.iam.gserviceaccount.com"

def base_config():
    payload = json.loads((ROOT / "infra/gcp/config.example.json").read_text())
    payload["GCP_WORKLOAD_IDENTITY_PROVIDER"] = DEPLOY_WIF
    payload["GCP_DEPLOY_SERVICE_ACCOUNT"] = DEPLOY_SA
    payload["GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER"] = BOOTSTRAP_WIF
    payload["GCP_BOOTSTRAP_SERVICE_ACCOUNT"] = ADMIN_SA
    return payload


class ConfigEnvTests(unittest.TestCase):
    def test_json_input_keeps_secret_references_and_extracts_two_wif_identities(self):
        with patch.dict(os.environ, {"GCP_CONFIG_ENV": json.dumps(base_config())}, clear=True):
            config, entries = app.read_input()
        self.assertNotIn("GCP_DEPLOY_SERVICE_ACCOUNT", config)
        self.assertEqual(config["workflow_secrets"]["TS_OAUTH_SECRET"]["version"], "1")
        app.validate_references(config)
        self.assertEqual(app.wif_metadata(entries), (DEPLOY_WIF, DEPLOY_SA))
        self.assertEqual(entries["GCP_BOOTSTRAP_SERVICE_ACCOUNT"], ADMIN_SA)

    @unittest.skipUnless(importlib.util.find_spec('dotenv'), 'dotenv is optional for JSON-only CI')
    def test_legacy_dotenv_accepts_workflow_secrets_and_json_nested(self):
        lines = [
            f"GCP_WORKLOAD_IDENTITY_PROVIDER={DEPLOY_WIF}",
            f"GCP_DEPLOY_SERVICE_ACCOUNT={DEPLOY_SA}",
            f"GCP_BOOTSTRAP_WORKLOAD_IDENTITY_PROVIDER={BOOTSTRAP_WIF}",
            f"GCP_BOOTSTRAP_SERVICE_ACCOUNT={ADMIN_SA}",
            "WORKFLOWS__WORKER__NAME=photointel-web",
            "WORKFLOWS__WORKER__DOMAIN=photos.test.invalid",
            "WORKFLOWS__WORKER__API_BASE_URL=https://api.photos.test.invalid",
            "WORKFLOW_SECRETS__TS_OAUTH_SECRET__NAME=photointel-tailscale-secret",
            "WORKFLOW_SECRETS__TS_OAUTH_SECRET__VERSION=1",
        ]
        with patch.dict(os.environ, {"GCP_CONFIG_ENV": "\n".join(lines)}, clear=True):
            config, entries = app.read_input()
        self.assertEqual(config["workflow_secrets"]["TS_OAUTH_SECRET"]["name"],
                         "photointel-tailscale-secret")
        self.assertEqual(config["workflows"]["worker"]["name"], "photointel-web")
        self.assertEqual(entries["GCP_BOOTSTRAP_SERVICE_ACCOUNT"], ADMIN_SA)

    def test_bootstrap_output_is_derived_from_same_config(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "outputs"
            with patch.dict(os.environ, {
                "GCP_CONFIG_ENV": json.dumps(base_config()),
                "GITHUB_OUTPUT": str(output),
            }, clear=True):
                app.write_outputs(DEPLOY_WIF, DEPLOY_SA)
            lines = output.read_text()
            self.assertIn("bootstrap_workload_identity_provider=" + BOOTSTRAP_WIF, lines)
            self.assertIn("bootstrap_service_account=" + ADMIN_SA, lines)

    def test_invalid_partial_bootstrap_identity_fails_closed(self):
        data = base_config()
        data.pop("GCP_BOOTSTRAP_SERVICE_ACCOUNT")
        with patch.dict(os.environ, {"GCP_CONFIG_ENV": json.dumps(data)}, clear=True):
            _, entries = app.read_input()
            with self.assertRaises(SystemExit):
                app.wif_metadata(entries)

    def test_secret_payloads_cannot_replace_reference_entries(self):
        config = base_config()
        config["workflow_secrets"]["TS_OAUTH_SECRET"] = "plaintext-secret"
        with patch.dict(os.environ, {"GCP_CONFIG_ENV": json.dumps(config)}, clear=True):
            obj, _ = app.read_input()
            with self.assertRaises((SystemExit, ValueError, TypeError)):
                app.validate_references(obj)


if __name__ == "__main__":
    unittest.main()
