"""Regression tests for ANSI rendering of Python and Node.js output."""
import unittest

from scripts.ci.highlight_output import highlight


class HighlightOutputTests(unittest.TestCase):
    def test_python_traceback(self):
        output = highlight('Traceback (most recent call last):\n')
        self.assertIn('\x1b[1;31mTraceback\x1b[0m', output)

    def test_python_file_location(self):
        output = highlight('  File "apps/api/main.py", line 42, in main\n')
        self.assertIn('\x1b[36mFile "apps/api/main.py", line 42\x1b[0m', output)

    def test_node_error(self):
        output = highlight('TypeError: Cannot read properties of undefined\n')
        self.assertIn('\x1b[1;31mTypeError\x1b[0m', output)

    def test_node_location(self):
        output = highlight('    at start (src/index.ts:12:4)\n')
        self.assertIn('\x1b[36mat start (src/index.ts:12:4)\x1b[0m', output)

    def test_success(self):
        self.assertIn('\x1b[1;32mpassed\x1b[0m', highlight('12 passed'))

    def test_existing_ansi_unchanged(self):
        raw = '\x1b[31mError\x1b[0m\n'
        self.assertEqual(highlight(raw), raw)

    def test_uncolored_line_unchanged(self):
        self.assertEqual(highlight('plain text\n'), 'plain text\n')


if __name__ == "__main__":
    unittest.main()
