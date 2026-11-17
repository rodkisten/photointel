"""CI scope selection regression tests."""
import unittest
from unittest.mock import patch
import subprocess

from scripts.ci.select_context import JOBS, changed_files, select


class ContextTests(unittest.TestCase):
    def test_manual_default_all(self):
        self.assertEqual(select([], "all"), set(JOBS))

    def test_each_manual_scope(self):
        for name in JOBS:
            with self.subTest(name=name):
                self.assertEqual(select(["apps/api/main.py"], name), {name})

    def test_web_change(self):
        self.assertEqual(select(["apps/web/src/app.tsx"]), {"frontend", "containers", "security"})

    def test_manage_change(self):
        self.assertEqual(select(["apps/manage/src/index.tsx"]), {"frontend", "security"})

    def test_python_change(self):
        self.assertEqual(select(["gpu/worker.py"]), {"python", "security"})

    def test_api_change(self):
        self.assertEqual(select(["apps/api/src/main.py"]), {"python", "integration", "containers", "security"})

    def test_docs_only(self):
        self.assertEqual(select(["docs/readme.md"]), set())

    def test_shared_change(self):
        self.assertEqual(select(["scripts/ci/highlight_output.py"]), set(JOBS))

    def test_unknown_initial_revision(self):
        self.assertEqual(changed_files("0" * 40, "HEAD"), ["*"])

    def test_git_diff_failure_is_safe(self):
        with patch("scripts.ci.select_context.subprocess.run", side_effect=subprocess.CalledProcessError(1, "git")):
            self.assertEqual(changed_files("abc", "def"), ["*"])

    def test_invalid_scope(self):
        with self.assertRaises(ValueError):
            select([], "invalid")


if __name__ == "__main__":
    unittest.main()
