"""Portable Keychain policy tests; native Apple framework execution is not simulated."""

import getpass
import io
import json
import tempfile
import unittest
import urllib.error
import warnings
from collections.abc import Callable
from contextlib import redirect_stdout
from email.message import Message
from pathlib import Path
from unittest.mock import MagicMock, Mock, call, patch

from bridges.pyto.bridge import (
    AccessCredentials,
    Bridge,
    BridgeError,
    Client,
    KeychainStore,
    SecurityKeychain,
    main,
    prompt_access_credentials,
)


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
        self.assert_error(
            "KEYCHAIN_ENTITLEMENT_MISSING", lambda: self.store.get(self.account)
        )

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


class AccessPolicyTests(unittest.TestCase):
    origin = "https://photos.example.com"

    def setUp(self) -> None:
        self.backend = MemoryKeychain()
        self.store = KeychainStore(self.backend)
        self.credentials = AccessCredentials("test-client.access", "test-service-secret")

    def test_optional_access_credentials_are_scoped_to_backend(self) -> None:
        self.credentials.save(self.store, self.origin)
        self.assertEqual(
            AccessCredentials.load(self.store, self.origin), self.credentials
        )
        self.assertIsNone(AccessCredentials.load(self.store, "https://other.example.com"))
        self.assertIsNone(self.store.get(self.origin))
        self.assertNotIn("test-service-secret", repr(self.credentials))

    def test_pair_rotation_uses_one_verified_keychain_item(self) -> None:
        self.credentials.save(self.store, self.origin)
        updated = AccessCredentials("updated-client.access", "rotated-test-secret")
        updated.save(self.store, self.origin)
        self.assertEqual(len(self.backend.items), 1)
        self.assertEqual(AccessCredentials.load(self.store, self.origin), updated)

    def test_access_fields_reject_header_injection_and_oversized_values(self) -> None:
        for value in ("", "with space", "client\r\nInjected: value", "x" * 1025):
            with self.subTest(length=len(value)), self.assertRaises(BridgeError):
                AccessCredentials("test-client.access", value)
        with self.assertRaises(BridgeError):
            AccessCredentials("x" * 257, "test-secret")

    def test_invalid_keychain_envelope_is_rejected(self) -> None:
        key = AccessCredentials.account(self.origin)
        for raw in ("[]", '{"id":"test"}', '{"id":3,"secret":"test"}'):
            with self.subTest(raw=raw), self.assertRaises(BridgeError) as caught:
                self.backend.items[key] = raw.encode()
                AccessCredentials.load(self.store, self.origin)
            self.assertEqual(caught.exception.code, "ACCESS_CREDENTIAL_INVALID")

    def test_transport_sends_two_independent_identities(self) -> None:
        response = MagicMock()
        response.read.return_value = b'{"ok":true}'
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch(
            "bridges.pyto.bridge.urllib.request.build_opener", return_value=opener
        ):
            result = Client(self.origin, "test-device-bearer", self.credentials).request(
                "GET", "/v1/bridge/status"
            )
        self.assertEqual(result, {"ok": True})
        request = opener.open.call_args.args[0]
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["authorization"], "Bearer test-device-bearer")
        self.assertEqual(headers["cf-access-client-id"], "test-client.access")
        self.assertEqual(headers["cf-access-client-secret"], "test-service-secret")
        self.assertEqual(request.full_url, self.origin + "/v1/bridge/status")
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 30)

    def test_transport_omits_access_headers_when_unconfigured(self) -> None:
        response = MagicMock()
        response.read.return_value = b'{"ok":true}'
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch(
            "bridges.pyto.bridge.urllib.request.build_opener", return_value=opener
        ):
            Client(self.origin, "test-device-bearer").request("GET", "/v1/bridge/status")
        headers = dict(opener.open.call_args.args[0].header_items())
        self.assertFalse(any(key.lower().startswith("cf-access-") for key in headers))

    def test_service_credentials_cannot_target_other_routes_or_origins(self) -> None:
        client = Client(self.origin, "test-device-bearer", self.credentials)
        for path in (
            "https://other.example.com/v1/bridge/status",
            "//other.example.com/v1/bridge/status",
            "/v1/settings",
            "/v1/bridge/../settings",
            "/v1/bridge/%2e%2e/settings",
            "/v1/bridge/status#fragment",
            "/v1/bridge/status\n",
        ):
            with self.subTest(path=path), self.assertRaises(BridgeError) as caught:
                client.request("GET", path)
            self.assertEqual(caught.exception.code, "INVALID_BRIDGE_PATH")

    def test_access_login_redirect_is_actionable_and_never_followed(self) -> None:
        headers = Message()
        headers["Location"] = (
            "https://team.cloudflareaccess.com/cdn-cgi/access/login/secret"
        )
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            self.origin, 302, "Found", headers, io.BytesIO(b"login page")
        )
        with (
            patch(
                "bridges.pyto.bridge.urllib.request.build_opener", return_value=opener
            ) as build,
            self.assertRaises(BridgeError) as caught,
        ):
            Client(self.origin, "test-device-bearer", self.credentials).request(
                "GET", "/v1/bridge/status"
            )
        self.assertEqual(caught.exception.code, "CLOUDFLARE_ACCESS_REQUIRED")
        self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(opener.open.call_count, 1)
        handler = build.call_args.args[0]()
        self.assertIsNone(handler.redirect_request(None, None, 302, "", None, ""))

    def test_unexpected_redirect_also_fails_without_following(self) -> None:
        headers = Message()
        headers["Location"] = "https://other.example.com/"
        opener = Mock()
        opener.open.side_effect = urllib.error.HTTPError(
            self.origin, 307, "Redirect", headers, io.BytesIO(b"")
        )
        with (
            patch("bridges.pyto.bridge.urllib.request.build_opener", return_value=opener),
            self.assertRaises(BridgeError) as caught,
        ):
            Client(self.origin).request("GET", "/v1/bridge/status")
        self.assertEqual(caught.exception.code, "BACKEND_REDIRECT_BLOCKED")
        self.assertEqual(opener.open.call_count, 1)

    def test_enrollment_and_subsequent_clients_load_service_auth(self) -> None:
        self.credentials.save(self.store, self.origin)
        with tempfile.TemporaryDirectory() as directory:
            bridge = Bridge(Path(directory) / "bridge.json")
            with (
                patch("bridges.pyto.bridge.KeychainStore", return_value=self.store),
                patch(
                    "bridges.pyto.bridge.Client.request",
                    autospec=True,
                    return_value={
                        "device": {"id": "test-device"},
                        "credential": "device-token",
                    },
                ) as request,
            ):
                bridge.enroll(self.origin, "one-use-code", "test-name")
                enrollment_client = request.call_args.args[0]
                self.assertEqual(enrollment_client.access, self.credentials)
                self.assertIsNone(enrollment_client.token)
                client = bridge.client()
                self.assertEqual(client.access, self.credentials)
                self.assertEqual(client.token, "device-token")
            raw = bridge.config_path.read_text()
            self.assertNotIn("test-service-secret", raw)
            self.assertNotIn("test-client.access", raw)
            self.assertNotIn("device-token", raw)

    def test_prompt_refuses_echo_fallback(self) -> None:
        def insecure_getpass(prompt: str) -> str:
            warnings.warn("Cannot hide input", getpass.GetPassWarning, stacklevel=2)
            return "must-not-be-used"

        with (
            patch("bridges.pyto.bridge.getpass.getpass", side_effect=insecure_getpass),
            self.assertRaises(BridgeError) as caught,
        ):
            prompt_access_credentials()
        self.assertEqual(caught.exception.code, "ACCESS_INPUT_UNAVAILABLE")

    def test_access_command_uses_hidden_prompts_and_never_writes_plaintext(self) -> None:
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "bridge.json"
            with (
                patch("bridges.pyto.bridge.KeychainStore", return_value=self.store),
                patch(
                    "bridges.pyto.bridge.getpass.getpass",
                    side_effect=["test-client.access", "test-service-secret"],
                ) as prompt,
                redirect_stdout(output),
            ):
                status = main(["--config", str(config), "access", "--url", self.origin])
            self.assertEqual(status, 0)
            self.assertEqual(prompt.call_count, 2)
            self.assertFalse(config.exists())
        self.assertTrue(json.loads(output.getvalue())["result"]["configured"])
        self.assertNotIn("test-service-secret", output.getvalue())
        self.assertNotIn("test-client.access", output.getvalue())


if __name__ == "__main__":
    unittest.main()
