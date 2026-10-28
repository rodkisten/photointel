"""Offline checks for production env staging and secret isolation."""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location(
    "workflow_env", ROOT / "infra/scripts/prepare_workflow_env.py"
)
assert spec and spec.loader
loader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loader)


def values(**changes):
    return {
        "VITE_API_BASE_URL": "https://api.example.org",
        "PAGES_PROJECT": "photointel",
        "CLOUDFLARE_API_TOKEN": "secret-value-not-for-logs",
        "CLOUDFLARE_ACCOUNT_ID": "a" * 32,
        "GITHUB_SHA": "b" * 40,
        **changes,
    }


class WorkflowEnvTests(unittest.TestCase):
    def test_pages_stages_public_values_not_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "env"
            path.touch()
            with patch.dict(os.environ, values(GITHUB_ENV=str(path)), clear=True):
                loader.append_public_env(loader.pages_environment())
            staged = path.read_text()
        self.assertEqual(staged.splitlines(), [
            "VITE_API_BASE_URL=https://api.example.org",
            "PAGES_PROJECT=photointel",
            "VITE_RELEASE_ID=" + "b" * 40,
        ])
        self.assertNotIn("secret-value", staged)
        self.assertNotIn("CLOUDFLARE_ACCOUNT_ID", staged)

    def test_same_origin_is_allowed(self):
        with patch.dict(os.environ, values(VITE_API_BASE_URL=""), clear=True):
            self.assertEqual(loader.pages_environment()["VITE_API_BASE_URL"], "")

    def test_malformed_values_are_rejected_without_echoing_them(self):
        for changes in (
            {"VITE_API_BASE_URL": "http://api.example.org"},
            {"VITE_API_BASE_URL": "https://api.example.org/path"},
            {"VITE_API_BASE_URL": "https://user:password@api.example.org"},
            {"PAGES_PROJECT": "photointel\nDANGER=bad"},
            {"CLOUDFLARE_ACCOUNT_ID": "invalid"},
            {"CLOUDFLARE_API_TOKEN": ""},
            {"GITHUB_SHA": "invalid"},
        ):
            with self.subTest(changes=list(changes)), patch.dict(os.environ, values(**changes), clear=True):
                with self.assertRaises(loader.WorkflowEnvironmentError) as err:
                    loader.pages_environment()
                self.assertNotIn("DANGER=bad", str(err.exception))
                self.assertNotIn("user:password", str(err.exception))

    def test_ssh_never_exports_oauth_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "env"
            path.touch()
            with patch.dict(os.environ, {
                "TS_OAUTH_CLIENT_ID": "private-client",
                "TS_OAUTH_SECRET": "private-secret",
                "GITHUB_ENV": str(path),
            }, clear=True):
                loader.ssh_environment()
            self.assertEqual(path.read_text(), "")
        with patch.dict(os.environ, {"TS_OAUTH_CLIENT_ID": "private-client"}, clear=True):
            with self.assertRaises(loader.WorkflowEnvironmentError):
                loader.ssh_environment()

    def test_production_steps_and_isolated_validation(self):
        for name in ("gcp-deploy.yml", "gcp-bootstrap.yml", "gcp-migrate.yml"):
            source = (ROOT / ".github/workflows" / name).read_text()
            self.assertIn('name: "⚙ Env"', source)
            self.assertIn("config-env: " + "$" + "{{ vars.GCP_CONFIG_ENV }}", source)
            self.assertIn("environment: production", source)
            self.assertEqual(source.count("uses: ./.github/actions/gcp-config"), 2)

        pages = (ROOT / ".github/workflows/deploy-pages.yml").read_text()
        self.assertIn('name: "⚙ Env"', pages)
        self.assertIn("python3 infra/scripts/prepare_workflow_env.py pages", pages)
        self.assertLess(pages.index("id: pages_env"), pages.index("npm --prefix apps/web ci"))
        ssh = (ROOT / ".github/workflows/ssh.yml").read_text()
        self.assertIn('name: "⚙ Env"', ssh)
        self.assertIn("python3 infra/scripts/prepare_workflow_env.py ssh", ssh)
        self.assertLess(ssh.index("id: ssh_env"), ssh.index("run: make setup"))

        for name in ("ci.yml", "bootstrap-validation.yml", "compose-validation.yml",
                     "container-architectures.yml", "gcp-validation.yml",
                     "real-cpu-smoke.yml", "webkit-validation.yml"):
            source = (ROOT / ".github/workflows" / name).read_text()
            self.assertNotIn("\n        uses: ./.github/actions/gcp-config\n", source)
            self.assertNotIn("\n    environment: production\n", source)


if __name__ == "__main__":
    unittest.main()
