"""Exercise actual setup functions with controlled providers, never Apple credentials."""
import argparse
import ast
import asyncio
import json
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

ROOT = Path(__file__).resolve().parents[3]


def load_functions(path, namespace):
    tree = ast.parse(path.read_text())
    tree.body = [node for node in tree.body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    exec(compile(tree, str(path), "exec"), namespace)
    return types.SimpleNamespace(**namespace)


class Settings:
    def __init__(self, **values):
        self.__dict__.update(icloud_session_backend="encrypted_object",
                             icloud_session_directory=Path("unused"),
                             icloud_account="user@icloud.com", icloud_library="",
                             icloud_session_max_bytes=1024)
        self.__dict__.update(values)

    def model_copy(self, *, update):
        return Settings(**{**self.__dict__, **update})


def admin_namespace():
    return dict(argparse=argparse, asyncio=asyncio, json=json, subprocess=subprocess,
                sys=sys, tempfile=tempfile, Path=Path, Any=object, Settings=Settings,
                AppError=RuntimeError)


class InteractiveSetupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ns = admin_namespace()
        self.admin = load_functions(
            ROOT / "apps/api/src/photointel/services/icloud_admin.py", self.ns)

    async def test_publish_only_after_verified_login_and_restore_before_saving_selection(self):
        events, staged_paths = [], []

        def authenticate(settings):
            staged_paths.append(settings.icloud_session_directory)
            events.append("login")

        @asynccontextmanager
        async def directory(settings, require_existing=True):
            events.append("restore" if require_existing else "publish")
            with tempfile.TemporaryDirectory() as temporary:
                yield Path(temporary)
            events.append("restored" if require_existing else "published")

        async def save(settings):
            events.append("saved")
            self.assertEqual(settings.icloud_library, "PrimarySync")

        adapter = Mock()
        adapter.return_value.connect.return_value = ["PrimarySync"]
        self.ns.update(authenticate=authenticate, encryption_key=Mock(),
                       ICloudAdapter=adapter, session_directory=directory,
                       pack_directory=Mock(return_value=b"PRIVATE_COOKIES"),
                       unpack_directory=Mock(), save_selection=save,
                       inspect_access=Mock(return_value={"state": "valid"}))
        with patch.object(sys.stdin, "isatty", return_value=True):
            result = await self.admin.setup(Settings())
        self.assertEqual(events, ["login", "publish", "published", "restore", "restored", "saved"])
        self.assertTrue(result["session_published"])
        self.assertFalse(result["ingestion_started"])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertTrue(all(not path.exists() for path in staged_paths))

    async def test_failed_login_never_publishes_or_updates_settings(self):
        publish, save = Mock(), AsyncMock()
        self.ns.update(authenticate=Mock(side_effect=ValueError("login failed")),
                       encryption_key=Mock(), session_directory=publish,
                       save_selection=save)
        with patch.object(sys.stdin, "isatty", return_value=True):
            with self.assertRaises(ValueError):
                await self.admin.setup(Settings())
        publish.assert_not_called()
        save.assert_not_called()

    async def test_noninteractive_setup_never_contacts_apple(self):
        authenticate = Mock()
        self.ns["authenticate"] = authenticate
        with patch.object(sys.stdin, "isatty", return_value=False):
            with self.assertRaises(ValueError):
                await self.admin.setup(Settings())
        authenticate.assert_not_called()

    def test_unknown_library_is_not_silently_replaced(self):
        with self.assertRaises(ValueError):
            self.admin.choose_library(["PrimarySync"], "OtherLibrary")

    def test_password_and_mfa_are_only_console_providers(self):
        self.ns["_safe_session_directory"] = Mock()
        with patch.object(sys.stdin, "isatty", return_value=True), patch.object(
                subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
            self.admin.authenticate(Settings())
        command = run.call_args.args[0]
        self.assertIn("--auth-only", command)
        self.assertEqual(command[command.index("--password-provider") + 1], "console")
        self.assertEqual(command[command.index("--mfa-provider") + 1], "console")


class LauncherTests(unittest.TestCase):
    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "icloud_terminal", ROOT / "infra/scripts/icloud_terminal.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def document(self, *, version="1", backend="encrypted_object"):
        entries = [{"name": key, "valueFrom": {"secretKeyRef":
                   {"name": "photointel-" + key.lower().replace("_", "-"), "key": version}}}
                   for key in self.module.RUNTIME_SECRETS]
        entries += [{"name": "ICLOUD_SESSION_BACKEND", "value": backend},
                    {"name": "MODAL_TOKEN", "valueFrom": {"secretKeyRef":
                     {"name": "not-needed", "key": "1"}}}]
        return {"spec": {"template": {"spec": {"template": {"spec":
                {"containers": [{"env": entries}]}}}}}}

    def test_only_required_secret_references_are_resolved(self):
        calls = []

        def run(args, project):
            calls.append(args)
            return json.dumps(self.document()) if args[0] == "run" else "PRIVATE_VALUE"

        with patch.object(self.module, "gcloud", side_effect=run):
            result = self.module.runtime_environment("photointel", "us-central1")
        self.assertNotIn("MODAL_TOKEN", result)
        self.assertFalse(any("PRIVATE_VALUE" in value for args in calls for value in args))
        self.assertEqual(result["ICLOUD_ENABLED"], "false")
        self.assertEqual(result["GPU_ENABLED"], "false")

    def test_unpinned_secret_reference_is_rejected(self):
        with patch.object(self.module, "gcloud", return_value=json.dumps(self.document(version="latest"))):
            with self.assertRaises(self.module.SetupError):
                self.module.runtime_environment("photointel", "us-central1")

    def test_local_session_backend_cannot_be_claimed_as_cloud_setup(self):
        with patch.object(self.module, "gcloud", side_effect=lambda args, project:
                          json.dumps(self.document(backend="local")) if args[0] == "run" else "PRIVATE_VALUE"):
            with self.assertRaises(self.module.SetupError):
                self.module.runtime_environment("photointel", "us-central1")


if __name__ == "__main__":
    unittest.main()
