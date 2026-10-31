"""Offline checks for Cloudflare Workers static assets and private GCP secrets."""

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
        "frontend_origin": "https://photos.example.org",
        "api_origin": "https://api.photos.example.org",
        "workflows": {"worker": {
            "name": "photointel-web",
            "domain": "photos.example.org",
            "api_base_url": "https://api.photos.example.org",
        }},
        "workflow_secrets": {
            key: {"name": f"photointel-{key.lower().replace('_', '-')}", "version": "1"}
            for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
                        "TS_OAUTH_CLIENT_ID", "TS_OAUTH_SECRET")
        },
    }


class WorkflowEnvTests(unittest.TestCase):
    def test_worker_exports_only_public_information(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "env"
            path.touch()
            with patch.dict(os.environ, {
                "GITHUB_ENV": str(path), "GITHUB_SHA": "a" * 40,
            }, clear=True):
                loader.append_public_env(loader.worker_environment(example_config()))
            staged = path.read_text()
        self.assertEqual(staged.splitlines(), [
            "VITE_API_BASE_URL=https://api.photos.example.org",
            "WORKER_NAME=photointel-web",
            "WORKER_DOMAIN=photos.example.org",
            "VITE_RELEASE_ID=" + "a" * 40,
        ])
        self.assertNotIn("CLOUDFLARE_API_TOKEN", staged)
        self.assertNotIn("CLOUDFLARE_ACCOUNT_ID", staged)

    def test_refuse_replacing_api_relay_or_same_origin_api(self):
        for change, value in (
            ("name", "photointel-api-relay"),
            ("name", ""),
            ("name", "invalid space"),
            ("domain", "other.example.org"),
            ("domain", "other.example.org/invalid"),
            ("domain", ""),
            ("api_base_url", "https://photos.example.org"),
            ("api_base_url", "http://api.photos.example.org"),
            ("api_base_url", "https://api.photos.example.org/path"),
        ):
            with self.subTest(change=change, value=value):
                config = example_config()
                config["workflows"]["worker"][change] = value
                with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}, clear=True):
                    with self.assertRaises(loader.WorkflowEnvironmentError):
                        loader.worker_environment(config)

    def test_gcp_errors_classified_and_never_leak_secret(self):
        for stderr, expected in (
            (b"PERMISSION_DENIED private:abcd", "roles/secretmanager.secretAccessor"),
            (b"NOT_FOUND private:abcd", "Secret or version not found"),
            (b"FAILED_PRECONDITION: DISABLED private:abcd", "Secret version unavailable"),
            (b"unknown private:abcd", "Cannot access"),
        ):
            with self.subTest(expected=expected):
                safe = loader.explain_secret_access_failure(
                    "CLOUDFLARE_API_TOKEN", "photointel-token", "1", stderr
                )
                self.assertIn(expected, safe)
                self.assertNotIn("private:abcd", safe)

        class Failure:
            returncode = 1
            stdout = b"PRIVATE_VALUE"
            stderr = b"PERMISSION_DENIED password=VERY_PRIVATE"

        with patch.object(loader.subprocess, "run", return_value=Failure()) as call:
            with self.assertRaises(loader.WorkflowEnvironmentError) as raised:
                loader.secret_value(example_config(), "CLOUDFLARE_API_TOKEN")
        self.assertIn("roles/secretmanager.secretAccessor", str(raised.exception))
        self.assertNotIn("VERY_PRIVATE", str(raised.exception))
        self.assertEqual(call.call_args.args[0][:5], [
            "gcloud", "secrets", "versions", "access", "1",
        ])
        self.assertEqual(call.call_args.kwargs["stderr"], subprocess.PIPE)

    def test_worker_preflight_fails_before_build_on_missing_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "env"
            env_file.touch()
            with (
                patch.dict(os.environ, {
                    "GITHUB_ENV": str(env_file), "GITHUB_SHA": "a" * 40,
                }, clear=True),
                patch.object(loader, "read_config", return_value=example_config()),
                patch.object(loader, "secret_value", side_effect=loader.WorkflowEnvironmentError(
                    "Secret or version not found"
                )) as secret,
                patch("sys.argv", ["prepare_workflow_env.py", "worker"]),
                contextlib.redirect_stderr(io.StringIO()) as errors,
            ):
                status = loader.main()
            self.assertEqual(status, 1)
            self.assertEqual(secret.call_count, 1)
            self.assertIn("Secret or version not found", errors.getvalue())
            self.assertEqual(env_file.read_text(), "")

    def test_worker_deploy_uses_asset_only_spa_and_does_not_leak_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = root / "apps/web"
            (app / "dist").mkdir(parents=True)
            (app / "dist/index.html").write_text("<!doctype html>")
            observed = {}

            def fake_run(argv, **kwargs):
                observed["argv"] = argv
                observed["cwd"] = kwargs["cwd"]
                observed["env"] = kwargs["env"]
                config_file = Path(argv[argv.index("--config") + 1])
                observed["wrangler"] = json.loads(config_file.read_text())
                observed["mode"] = config_file.stat().st_mode & 0o777
                class Result:
                    returncode = 0
                return Result()

            with (
                patch.object(loader, "ROOT", root),
                patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}, clear=True),
                patch.object(loader, "secret_value", side_effect=[
                    "private-token", "a" * 32,
                ]),
                patch.object(loader.subprocess, "run", side_effect=fake_run),
            ):
                loader.worker_deploy(example_config())
            self.assertEqual(observed["argv"][:4], [
                "npx", "--yes", "wrangler@4", "deploy",
            ])
            self.assertEqual(observed["cwd"], app)
            self.assertEqual(observed["mode"], 0o600)
            self.assertEqual(observed["env"]["CLOUDFLARE_API_TOKEN"], "private-token")
            self.assertEqual(observed["wrangler"]["name"], "photointel-web")
            self.assertFalse(observed["wrangler"]["workers_dev"])
            self.assertFalse(observed["wrangler"]["preview_urls"])
            self.assertNotIn("main", observed["wrangler"])
            self.assertEqual(observed["wrangler"]["assets"], {
                "directory": "./dist",
                "not_found_handling": "single-page-application",
            })
            self.assertEqual(observed["wrangler"]["routes"], [
                {"pattern": "photos.example.org", "custom_domain": True},
            ])
            self.assertNotIn("private-token", json.dumps(observed["wrangler"]))
            self.assertEqual(list(app.glob(".wrangler-deploy-*.json")), [])

    def test_ssh_oauth_kept_only_in_job_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "outputs"
            public = Path(tmp) / "env"
            public.touch()
            with (
                patch.dict(os.environ, {
                    "GITHUB_OUTPUT": str(output), "GITHUB_ENV": str(public),
                }, clear=True),
                patch.object(loader, "secret_value", side_effect=[
                    "ts-client", "ts-secret",
                ]),
                contextlib.redirect_stdout(io.StringIO()) as masked,
            ):
                loader.ssh_environment(example_config())
            self.assertIn("ts_client_id=ts-client", output.read_text())
            self.assertIn("ts_oauth_secret=ts-secret", output.read_text())
            self.assertIn("::add-mask::ts-secret", masked.getvalue())
            self.assertEqual(public.read_text(), "")

    def test_production_workflows_share_gcp_config_and_keep_prs_isolated(self):
        for name in (
            "gcp-deploy.yml", "gcp-bootstrap.yml", "gcp-migrate.yml",
            "deploy-worker.yml", "ssh.yml",
        ):
            source = (ROOT / ".github/workflows" / name).read_text()
            self.assertIn("config-env: " + "$" + "{{ vars.GCP_CONFIG_ENV }}", source)
            self.assertIn('name: "⚙ Env"', source)
            self.assertIn("uses: ./.github/actions/gcp-config", source)
        worker = (ROOT / ".github/workflows/deploy-worker.yml").read_text()
        self.assertIn("prepare_workflow_env.py worker-deploy", worker)
        self.assertIn("prepare_workflow_env.py worker", worker)
        self.assertIn("worker-headers", worker)
        self.assertNotIn("wrangler pages", worker)
        self.assertFalse((ROOT / ".github/workflows/deploy-pages.yml").exists())
        ssh = (ROOT / ".github/workflows/ssh.yml").read_text()
        self.assertIn("steps.ssh_env.outputs.ts_client_id", ssh)
        for name in (
            "ci.yml", "bootstrap-validation.yml", "compose-validation.yml",
            "container-architectures.yml", "gcp-validation.yml",
            "real-cpu-smoke.yml", "webkit-validation.yml",
        ):
            source = (ROOT / ".github/workflows" / name).read_text()
            self.assertNotIn("\n        uses: ./.github/actions/gcp-config\n", source)
            self.assertNotIn("\n    environment: production\n", source)


if __name__ == "__main__":
    unittest.main()
