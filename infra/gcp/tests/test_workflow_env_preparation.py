"""Offline tests for GCP-configured Pages/SSH and Secret Manager isolation."""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "workflow_env", ROOT / "infra/scripts/prepare_workflow_env.py"
)
assert SPEC and SPEC.loader
loader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(loader)


def example_config():
    return {
        "project_id": "photointel",
        "workflows": {"pages": {
            "project": "photointel", "api_base_url": "https://api.photos.invalid",
        }},
        "workflow_secrets": {
            key: {"name": f"photointel-{key.lower().replace('_', '-')}", "version": "1"}
            for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
                        "TS_OAUTH_CLIENT_ID", "TS_OAUTH_SECRET")
        },
    }


class WorkflowEnvTests(unittest.TestCase):
    def test_pages_public_env_never_includes_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            envfile = Path(tmp) / "env"
            envfile.touch()
            with patch.dict(os.environ, {
                "GITHUB_ENV": str(envfile),
                "GITHUB_SHA": "a" * 40,
            }, clear=True):
                loader.append_public_env(loader.pages_environment(example_config()))
            staged = envfile.read_text()
        self.assertEqual(staged.splitlines(), [
            "VITE_API_BASE_URL=https://api.photos.invalid",
            "PAGES_PROJECT=photointel",
            "VITE_RELEASE_ID=" + "a" * 40,
        ])
        self.assertNotIn("CLOUDFLARE_API_TOKEN", staged)

    def test_invalid_public_configuration_fails_before_wrangle(self):
        for value in ("http://api.invalid", "https://u:p@api.invalid",
                      "https://api.invalid/path", "https://api.invalid/?token=x"):
            with self.subTest(value=value):
                config = example_config()
                config["workflows"]["pages"]["api_base_url"] = value
                with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}, clear=True):
                    with self.assertRaises(loader.WorkflowEnvironmentError):
                        loader.pages_environment(config)

    def test_gcp_access_is_pinned_and_never_leaks_error_output(self):
        class Failure:
            returncode = 1
            stdout = b"SECRET_PAYLOAD"
            stderr = b"error: password=VERY_PRIVATE"
        config = example_config()
        with patch.object(loader.subprocess, "run", return_value=Failure()) as run:
            with self.assertRaises(loader.WorkflowEnvironmentError) as exc:
                loader.secret_value(config, "CLOUDFLARE_API_TOKEN")
        self.assertNotIn("VERY_PRIVATE", str(exc.exception))
        self.assertNotIn("SECRET_PAYLOAD", str(exc.exception))
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[:4], ["gcloud", "secrets", "versions", "access"])
        self.assertEqual(cmd[4], "1")
        self.assertIn("photointel", cmd)
        self.assertTrue(run.call_args.kwargs["stderr"] == subprocess.PIPE)

    def test_pages_deploy_scopes_secrets_to_subprocess(self):
        class Success:
            returncode = 0
        cfg = example_config()
        with (
            patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}, clear=True),
            patch.object(loader, "secret_value",
                side_effect=["cf-token", "a" * 32]),
            patch.object(loader.subprocess, "run", return_value=Success()) as proc,
        ):
            loader.pages_deploy(cfg)
        args = proc.call_args.args[0]
        child = proc.call_args.kwargs["env"]
        self.assertEqual(args[:5], ["npx", "--yes", "wrangler@4", "pages", "deploy"])
        self.assertEqual(child["CLOUDFLARE_API_TOKEN"], "cf-token")
        self.assertEqual(child["CLOUDFLARE_ACCOUNT_ID"], "a" * 32)

    def test_ssh_masks_step_outputs_and_never_writes_github_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            outputs = Path(tmp) / "output"
            envfile = Path(tmp) / "env"
            envfile.touch()
            with (
                patch.dict(os.environ, {
                    "GITHUB_OUTPUT": str(outputs),
                    "GITHUB_ENV": str(envfile),
                }, clear=True),
                patch.object(loader, "secret_value", side_effect=[
                    "client-do-not-log", "oauth-do-not-log"
                ]),
                contextlib.redirect_stdout(io.StringIO()) as stream,
            ):
                loader.ssh_environment(example_config())
            written = outputs.read_text()
            self.assertIn("ts_client_id=client-do-not-log", written)
            self.assertIn("ts_oauth_secret=oauth-do-not-log", written)
            self.assertIn("::add-mask::client-do-not-log", stream.getvalue())
            self.assertIn("::add-mask::oauth-do-not-log", stream.getvalue())
            self.assertEqual(envfile.read_text(), "")

    def test_workflows_share_a_single_config_and_auth(self):
        for name in ("gcp-deploy.yml", "gcp-bootstrap.yml", "gcp-migrate.yml",
                     "deploy-pages.yml", "ssh.yml"):
            text = (ROOT / ".github/workflows" / name).read_text()
            with self.subTest(name=name):
                self.assertIn("config-env: " + "$" + "{{ vars.GCP_CONFIG_ENV }}", text)
                self.assertIn("uses: ./.github/actions/gcp-config", text)
                self.assertIn("environment:", text)
                self.assertIn('name: "⚙ Env"', text)

        pages = (ROOT / ".github/workflows/deploy-pages.yml").read_text()
        self.assertIn("prepare_workflow_env.py pages-deploy", pages)
        self.assertIn("prepare_workflow_env.py pages", pages)
        self.assertNotIn("vars.PAGES_PROJECT", pages)
        self.assertNotIn("vars.VITE_API_BASE_URL", pages)
        self.assertNotIn("secrets.CLOUDFLARE_API_TOKEN", pages)
        self.assertNotIn("secrets.CLOUDFLARE_ACCOUNT_ID", pages)

        ssh = (ROOT / ".github/workflows/ssh.yml").read_text()
        self.assertIn("steps.ssh_env.outputs.ts_client_id", ssh)
        self.assertIn("steps.ssh_env.outputs.ts_oauth_secret", ssh)
        self.assertNotIn("secrets.TS_OAUTH_CLIENT_ID", ssh)
        self.assertNotIn("secrets.TS_OAUTH_SECRET", ssh)
        self.assertIn("github.ref == 'refs/heads/main'", ssh)

        for name in ("ci.yml", "bootstrap-validation.yml", "compose-validation.yml",
                     "container-architectures.yml", "gcp-validation.yml",
                     "real-cpu-smoke.yml", "webkit-validation.yml"):
            text = (ROOT / ".github/workflows" / name).read_text()
            self.assertNotIn("\n        uses: ./.github/actions/gcp-config\n", text)
            self.assertNotIn("\n    environment: production\n", text)


if __name__ == "__main__":
    unittest.main()
