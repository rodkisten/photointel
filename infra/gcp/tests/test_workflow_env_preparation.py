"""Offline checks for unified Cloudflare Worker assets, API relay and private GCP secrets."""

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
        "region": "us-central1",
        "access_team_domain": "photointel.cloudflareaccess.com",
        "access_audience": "a" * 64,
        "frontend_origin": "https://photos.example.org",
        "api_origin": "https://photos.example.org",
        "workflows": {"worker": {
            "name": "photointel",
            "domain": "photos.example.org",
        }},
        "workflow_secrets": {
            key: {"name": f"photointel-{key.lower().replace('_', '-')}", "version": "1"}
            for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
                        "TS_OAUTH_CLIENT_ID", "TS_OAUTH_SECRET")
        },
    }


class WorkflowEnvTests(unittest.TestCase):
    def test_single_origin_exports_no_api_hostname_or_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "env"
            path.touch()
            with patch.dict(os.environ, {
                "GITHUB_ENV": str(path), "GITHUB_SHA": "a" * 40,
            }, clear=True):
                loader.append_public_env(loader.worker_environment(example_config()))
            staged = path.read_text()
        self.assertEqual(staged.splitlines(), [
            "VITE_API_BASE_URL=",
            "WORKER_NAME=photointel",
            "WORKER_DOMAIN=photos.example.org",
            "VITE_RELEASE_ID=" + "a" * 40,
        ])
        self.assertNotIn("CLOUDFLARE_API_TOKEN", staged)
        self.assertNotIn("CLOUDFLARE_ACCOUNT_ID", staged)

    def test_unified_name_and_frontend_host_are_guarded(self):
        for change, value in (
            ("name", "photointel-api-relay"),
            ("name", "untrusted-project"),
            ("domain", "other.example.org"),
            ("domain", "other.example.org/invalid"),
        ):
            with self.subTest(change=change, value=value):
                config = example_config()
                config["workflows"]["worker"][change] = value
                with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}, clear=True):
                    with self.assertRaises(loader.WorkflowEnvironmentError):
                        loader.worker_environment(config)
        config = example_config()
        del config["workflows"]["worker"]["name"]
        del config["workflows"]["worker"]["domain"]
        with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}, clear=True):
            self.assertEqual(
                loader.worker_environment(config)["WORKER_NAME"], "photointel"
            )

    def test_secret_error_sanitizes_gcloud_stderr(self):
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
        self.assertNotIn("VERY_PRIVATE", str(raised.exception))
        self.assertEqual(call.call_args.args[0][:5],
                         ["gcloud", "secrets", "versions", "access", "1"])
        self.assertTrue(call.call_args.kwargs["capture_output"])

    def test_worker_preflight_fails_before_build_when_secret_is_missing(self):
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

    def test_unified_deploy_reuses_live_frontend_worker_and_does_not_move_api_domain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            relay = root / "infra/cloudflare/cloud-run-proxy"
            relay.mkdir(parents=True)
            (relay / "worker.mjs").write_text("export default { fetch() {} };")
            dist = root / "apps/web/dist"
            dist.mkdir(parents=True)
            (dist / "index.html").write_text("<!doctype html>")
            observed = {}
            class Success:
                returncode = 0
                stdout = "https://photointel-api-abc-uc.a.run.app\n"
                stderr = ""

            def fake_run(argv, **kwargs):
                if argv[:4] == ["gcloud", "run", "services", "describe"]:
                    observed["gcloud"] = argv
                    return Success()
                observed["argv"] = argv
                observed["cwd"] = kwargs["cwd"]
                observed["env"] = kwargs["env"]
                config_file = Path(argv[argv.index("--config") + 1])
                observed["wrangler"] = json.loads(config_file.read_text())
                observed["mode"] = config_file.stat().st_mode & 0o777
                return Success()

            with (
                patch.object(loader, "ROOT", root),
                patch.object(loader, "RELAY_SCRIPT", relay / "worker.mjs"),
                patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}, clear=True),
                patch.object(loader, "secret_value", side_effect=[
                    "private-token", "a" * 32,
                ]),
                patch.object(loader.subprocess, "run", side_effect=fake_run),
            ):
                loader.worker_deploy(example_config())
            self.assertEqual(observed["argv"][:4],
                             ["npx", "--yes", "wrangler@4", "deploy"])
            self.assertEqual(observed["cwd"], relay)
            self.assertEqual(observed["mode"], 0o600)
            self.assertEqual(observed["env"]["CLOUDFLARE_API_TOKEN"], "private-token")
            cfg = observed["wrangler"]
            self.assertEqual(cfg["name"], "photointel")
            self.assertEqual(cfg["main"], "./worker.mjs")
            self.assertEqual(cfg["observability"], {
                "enabled": True, "head_sampling_rate": 1,
                "logs": {"enabled": True, "invocation_logs": False},
            })
            self.assertFalse(cfg["workers_dev"])
            self.assertFalse(cfg["preview_urls"])
            self.assertEqual(cfg["vars"], {
                "CLOUD_RUN_ORIGIN": "https://photointel-api-abc-uc.a.run.app",
                "FRONTEND_ORIGIN": "https://photos.example.org",
                "ACCESS_TEAM_DOMAIN": "photointel.cloudflareaccess.com",
                "ACCESS_AUDIENCE": "a" * 64,
                "RELEASE_SHA": "b" * 40,
            })
            self.assertEqual(cfg["assets"], {
                "directory": "../../../apps/web/dist",
                "binding": "ASSETS",
                "run_worker_first": True,
                "not_found_handling": "single-page-application",
            })
            self.assertEqual(cfg["routes"], [
                {"pattern": "photos.example.org", "custom_domain": True},
            ])
            self.assertIn("--format=value(status.url)", observed["gcloud"])
            self.assertNotIn("private-token", json.dumps(cfg))
            self.assertEqual(list(relay.glob(".wrangler-deploy-*.json")), [])

    def test_unsafe_cloud_run_origin_is_rejected(self):
        class Result:
            returncode = 0
            stdout = "https://evil.example.org"
        with patch.object(loader.subprocess, "run", return_value=Result()):
            with self.assertRaises(loader.WorkflowEnvironmentError):
                loader.discover_cloud_run_origin(example_config())

    def test_ssh_oauth_is_masked_in_step_outputs(self):
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

    def test_all_workflows_share_gcp_config_without_exposing_it_to_ci(self):
        for name in (
            "gcp-deploy.yml", "gcp-bootstrap.yml", "gcp-migrate.yml",
            "deploy-worker.yml", "ssh.yml",
        ):
            source = (ROOT / ".github/workflows" / name).read_text()
            self.assertIn("config-env: " + "$" + "{{ vars.GCP_CONFIG_ENV }}", source)
            self.assertIn('name: "⚙ Env"', source)
        worker = (ROOT / ".github/workflows/deploy-worker.yml").read_text()
        self.assertIn("python3 -m infra.scripts.prepare_workflow_env worker-deploy", worker)
        self.assertNotIn("wrangler pages", worker)
        self.assertFalse((ROOT / ".github/workflows/deploy-pages.yml").exists())
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


