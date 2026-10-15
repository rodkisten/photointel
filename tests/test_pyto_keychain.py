"""Portable Keychain policy tests; native Apple framework execution is not simulated."""

import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from unittest.mock import Mock, call, patch

from bridges.pyto.bridge import Bridge, BridgeError, KeychainStore, SecurityKeychain


class MemoryKeychain:
    """Only a test double for OSStatus handling, never selected by the application."""

    def __init__(self) -> None:
        self.items: dict[str, bytes] = {}
        self.calls: list[str] = []
        self.read_result: tuple[int, bytes | None] | None = None
        self.update_results: list[int] = []
        self.add_status: int | None = None

    def read(self, account: str) -> tuple[int, bytes | None]:
        self.calls.append("read")
        if self.read_result is not None:
            return self.read_result
        return (0, self.items[account]) if account in self.items else (-25300, None)

    def update(self, account: str, value: bytes) -> int:
        self.calls.append("update")
        if self.update_results:
            status = self.update_results.pop(0)
        else:
            status = 0 if account in self.items else -25300
        if status == 0:
            self.items[account] = value
        return status

    def add(self, account: str, value: bytes) -> int:
        self.calls.append("add")
        if self.add_status is not None:
            return self.add_status
        self.items[account] = value
        return 0


class KeychainPolicyTests(unittest.TestCase):
    account = "https://photos.example.com"

    def setUp(self) -> None:
        self.backend = MemoryKeychain()
        self.store = KeychainStore(self.backend)

    def assert_error(self, expected: str, callback: Callable[[], object]) -> None:
        self.assertTrue(callable(callback))
        with self.assertRaises(BridgeError) as caught:
            callback()
        self.assertEqual(caught.exception.code, expected)
        self.assertNotIn("private-test-credential", str(caught.exception))

    def test_not_found_is_the_only_empty_credential_result(self) -> None:
        self.assertIsNone(self.store.get(self.account))
        self.backend.read_result = (0, None)
        self.assert_error("KEYCHAIN_INVALID_DATA", lambda: self.store.get(self.account))

    def test_read_decodes_utf8(self) -> None:
        self.backend.items[self.account] = b"private-test-credential"
        self.assertEqual(self.store.get(self.account), "private-test-credential")

    def test_empty_invalid_and_oversized_values_are_rejected(self) -> None:
        for raw in (b"", b"\xff", b"a\x00b", b"x" * 4097):
            with self.subTest(raw_length=len(raw)):
                self.backend.read_result = (0, raw)
                self.assert_error(
                    "KEYCHAIN_INVALID_DATA", lambda: self.store.get(self.account)
                )

    def test_locked_device_is_actionable(self) -> None:
        self.backend.read_result = (-25308, None)
        self.assert_error("KEYCHAIN_LOCKED", lambda: self.store.get(self.account))

    def test_entitlement_error_is_not_a_missing_credential(self) -> None:
        self.backend.read_result = (-34018, None)
        self.assert_error("KEYCHAIN_UNAVAILABLE", lambda: self.store.get(self.account))

    def test_new_credential_is_read_back(self) -> None:
        self.store.set(self.account, "private-test-credential")
        self.assertEqual(self.backend.calls, ["update", "add", "read"])
        self.assertEqual(self.backend.items[self.account], b"private-test-credential")

    def test_rotation_updates_without_duplicate_item(self) -> None:
        self.backend.items[self.account] = b"old-test-credential"
        self.store.set(self.account, "private-test-credential")
        self.assertEqual(self.backend.calls, ["update", "read"])

    def test_duplicate_add_race_retries_update_once(self) -> None:
        self.backend.update_results = [-25300, 0]
        self.backend.add_status = -25299
        self.store.set(self.account, "private-test-credential")
        self.assertEqual(self.backend.calls, ["update", "add", "update", "read"])

    def test_failed_add_does_not_fabricate_success(self) -> None:
        self.backend.add_status = -25308
        self.assert_error(
            "KEYCHAIN_LOCKED", lambda: self.store.set(self.account, "test-value")
        )
        self.assertEqual(self.backend.calls, ["update", "add"])

    def test_mismatched_read_back_is_a_failure(self) -> None:
        self.backend.read_result = (0, b"unexpected-test-value")
        self.assert_error(
            "KEYCHAIN_VERIFICATION_FAILED",
            lambda: self.store.set(self.account, "private-test-credential"),
        )

    def test_inputs_are_bounded_before_native_calls(self) -> None:
        for account in ("", "https://example.com\x00", "x" * 2049):
            with self.subTest(account_length=len(account)):
                self.assert_error(
                    "KEYCHAIN_INVALID_DATA",
                    lambda account=account: self.store.get(account),
                )
        for value in ("", "x" * 4097, "credential\x00"):
            with self.subTest(value_length=len(value)):
                self.assert_error(
                    "KEYCHAIN_INVALID_DATA",
                    lambda value=value: self.store.set(self.account, value),
                )
        self.assertEqual(self.backend.calls, [])

    def test_availability_probe_does_not_write(self) -> None:
        self.store.check_available()
        self.assertEqual(self.backend.calls, ["read"])
        self.assertEqual(self.backend.items, {})

    def test_unsupported_runtime_refuses_insecure_fallback(self) -> None:
        with (
            patch("bridges.pyto.bridge.sys.platform", "linux"),
            patch("bridges.pyto.bridge.platform.system", return_value="Linux"),
        ):
            self.assert_error("KEYCHAIN_UNAVAILABLE", SecurityKeychain)

    def test_missing_framework_is_an_actionable_error(self) -> None:
        with (
            patch("bridges.pyto.bridge.platform.system", return_value="Darwin"),
            patch(
                "bridges.pyto.bridge.ctypes.CDLL",
                side_effect=OSError("native unavailable"),
            ),
        ):
            self.assert_error("KEYCHAIN_UNAVAILABLE", SecurityKeychain)

    def test_created_cf_objects_are_released_when_an_operation_fails(self) -> None:
        native = SecurityKeychain.__new__(SecurityKeychain)
        native.cf = Mock()
        with (
            self.assertRaisesRegex(RuntimeError, "test failure"),
            native._scope() as owned,
        ):
            owned.extend([101, 202])
            raise RuntimeError("test failure")
        self.assertEqual(native.cf.CFRelease.call_args_list, [call(202), call(101)])

    def test_enrollment_is_not_sent_when_keychain_query_fails(self) -> None:
        self.backend.read_result = (-25308, None)
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge(Path(directory) / "bridge.json")
            with (
                patch("bridges.pyto.bridge.KeychainStore", return_value=self.store),
                patch("bridges.pyto.bridge.Client.request") as request,
            ):
                self.assert_error(
                    "KEYCHAIN_LOCKED",
                    lambda: bridge.enroll(self.account, "one-use-code", "test-device"),
                )
                request.assert_not_called()
            self.assertFalse(bridge.config_path.exists())


if __name__ == "__main__":
    unittest.main()
