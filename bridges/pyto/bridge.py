#!/usr/bin/env python3
"""Photo Intelligence Pyto Bridge. JSON CLI, bounded PhotoKit inventory, no writes.

Runs directly in Pyto or is imported by a Shortcut/Pyto script. Python's standard
library is sufficient for the transport. PhotoKit uses Pyto's Rubicon ObjC bridge;
unsupported runtimes report capabilities rather than inventing success.
"""

from __future__ import annotations

import argparse
import ctypes
import getpass
import hashlib
import json
import os
import platform
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

UTC = timezone.utc  # noqa: UP017 - Pyto may embed Python 3.10.

KEYCHAIN_SERVICE = "photo-intelligence-cloud.bridge"
AUTHORIZATION = {
    0: "not_determined",
    1: "denied",
    2: "denied",
    3: "authorized",
    4: "limited",
}


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class KeychainBackend(Protocol):
    """Small boundary for the public Security.framework functions, not a file store."""

    def read(self, account: str) -> tuple[int, bytes | None]: ...

    def update(self, account: str, value: bytes) -> int: ...

    def add(self, account: str, value: bytes) -> int: ...


class SecurityKeychain:
    """Bind Apple's documented C Keychain APIs with the Python standard library.

    CF objects created by this adapter follow the Create/Copy ownership rule.
    Dictionaries retain keys/values with the standard CFType callbacks. No
    Pythonista-only module, NSUserDefaults, or plaintext credential fallback is used.
    Loading these bindings does not establish successful access on an iOS device.
    """

    def __init__(self) -> None:
        if sys.platform != "ios" and platform.system() != "Darwin":
            raise BridgeError("KEYCHAIN_UNAVAILABLE", "Keychain exige um runtime Apple")
        try:
            self.security = ctypes.CDLL(
                "/System/Library/Frameworks/Security.framework/Security"
            )
            self.cf = ctypes.CDLL(
                "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
            )
            self._bind()
        except (OSError, AttributeError, ValueError) as exc:
            raise BridgeError(
                "KEYCHAIN_UNAVAILABLE", "Security.framework não está acessível neste Pyto"
            ) from exc

    def _bind(self) -> None:
        pointer = ctypes.c_void_p
        self.cf.CFStringCreateWithCString.argtypes = [
            pointer,
            ctypes.c_char_p,
            ctypes.c_uint32,
        ]
        self.cf.CFStringCreateWithCString.restype = pointer
        self.cf.CFDataCreate.argtypes = [
            pointer,
            ctypes.POINTER(ctypes.c_ubyte),
            ctypes.c_long,
        ]
        self.cf.CFDataCreate.restype = pointer
        self.cf.CFDictionaryCreateMutable.argtypes = [
            pointer,
            ctypes.c_long,
            pointer,
            pointer,
        ]
        self.cf.CFDictionaryCreateMutable.restype = pointer
        self.cf.CFDictionarySetValue.argtypes = [pointer, pointer, pointer]
        self.cf.CFDictionarySetValue.restype = None
        self.cf.CFDataGetLength.argtypes = [pointer]
        self.cf.CFDataGetLength.restype = ctypes.c_long
        self.cf.CFDataGetBytePtr.argtypes = [pointer]
        self.cf.CFDataGetBytePtr.restype = pointer
        self.cf.CFGetTypeID.argtypes = [pointer]
        self.cf.CFGetTypeID.restype = ctypes.c_ulong
        self.cf.CFDataGetTypeID.argtypes = []
        self.cf.CFDataGetTypeID.restype = ctypes.c_ulong
        self.cf.CFRelease.argtypes = [pointer]
        self.cf.CFRelease.restype = None
        self.security.SecItemCopyMatching.argtypes = [pointer, ctypes.POINTER(pointer)]
        self.security.SecItemCopyMatching.restype = ctypes.c_int32
        self.security.SecItemAdd.argtypes = [pointer, ctypes.POINTER(pointer)]
        self.security.SecItemAdd.restype = ctypes.c_int32
        self.security.SecItemUpdate.argtypes = [pointer, pointer]
        self.security.SecItemUpdate.restype = ctypes.c_int32
        # These exported values are structures, so their addresses must be passed;
        # reading the first word as a pointer would be an invalid callback table.
        self._key_callbacks = ctypes.addressof(
            ctypes.c_byte.in_dll(self.cf, "kCFTypeDictionaryKeyCallBacks")
        )
        self._value_callbacks = ctypes.addressof(
            ctypes.c_byte.in_dll(self.cf, "kCFTypeDictionaryValueCallBacks")
        )
        names = (
            "kSecClass",
            "kSecClassGenericPassword",
            "kSecAttrService",
            "kSecAttrAccount",
            "kSecValueData",
            "kSecReturnData",
            "kSecMatchLimit",
            "kSecMatchLimitOne",
            "kSecAttrAccessible",
            "kSecAttrAccessibleWhenUnlockedThisDeviceOnly",
        )
        self._constants = {
            name: ctypes.c_void_p.in_dll(self.security, name).value for name in names
        }
        self._constants["kCFBooleanTrue"] = ctypes.c_void_p.in_dll(
            self.cf, "kCFBooleanTrue"
        ).value
        if not all(self._constants.values()):
            raise ValueError("Required Security constants unavailable")

    @contextmanager
    def _scope(self) -> Iterator[list[int]]:
        owned: list[int] = []
        try:
            yield owned
        finally:
            for reference in reversed(owned):
                self.cf.CFRelease(reference)

    @staticmethod
    def _own(reference: int | None, owned: list[int]) -> int:
        if not reference:
            raise BridgeError(
                "KEYCHAIN_UNAVAILABLE", "Falha ao preparar consulta Keychain"
            )
        owned.append(reference)
        return reference

    def _string(self, value: str, owned: list[int]) -> int:
        return self._own(
            self.cf.CFStringCreateWithCString(None, value.encode("utf-8"), 0x08000100),
            owned,
        )

    def _data(self, value: bytes, owned: list[int]) -> int:
        buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
        return self._own(self.cf.CFDataCreate(None, buffer, len(value)), owned)

    def _dictionary(self, owned: list[int]) -> int:
        return self._own(
            self.cf.CFDictionaryCreateMutable(
                None, 0, self._key_callbacks, self._value_callbacks
            ),
            owned,
        )

    def _put(self, query: int, key: str, value: int | None) -> None:
        self.cf.CFDictionarySetValue(query, self._constants[key], value)

    def _query(self, account: str, owned: list[int]) -> int:
        query = self._dictionary(owned)
        self._put(query, "kSecClass", self._constants["kSecClassGenericPassword"])
        self._put(query, "kSecAttrService", self._string(KEYCHAIN_SERVICE, owned))
        self._put(query, "kSecAttrAccount", self._string(account, owned))
        return query

    def read(self, account: str) -> tuple[int, bytes | None]:
        with self._scope() as owned:
            query = self._query(account, owned)
            self._put(query, "kSecReturnData", self._constants["kCFBooleanTrue"])
            self._put(query, "kSecMatchLimit", self._constants["kSecMatchLimitOne"])
            result = ctypes.c_void_p()
            status = int(self.security.SecItemCopyMatching(query, ctypes.byref(result)))
            if result.value:
                owned.append(result.value)
            if status != 0:
                return status, None
            if (
                not result.value
                or self.cf.CFGetTypeID(result) != self.cf.CFDataGetTypeID()
            ):
                raise BridgeError(
                    "KEYCHAIN_INVALID_DATA", "Formato de credencial inválido"
                )
            length = int(self.cf.CFDataGetLength(result))
            if not 0 < length <= 4096:
                raise BridgeError(
                    "KEYCHAIN_INVALID_DATA", "Tamanho de credencial inválido"
                )
            data = self.cf.CFDataGetBytePtr(result)
            if not data:
                raise BridgeError("KEYCHAIN_INVALID_DATA", "Credencial não pôde ser lida")
            return status, ctypes.string_at(data, length)

    def update(self, account: str, value: bytes) -> int:
        with self._scope() as owned:
            query = self._query(account, owned)
            changes = self._dictionary(owned)
            self._put(changes, "kSecValueData", self._data(value, owned))
            self._put(
                changes,
                "kSecAttrAccessible",
                self._constants["kSecAttrAccessibleWhenUnlockedThisDeviceOnly"],
            )
            return int(self.security.SecItemUpdate(query, changes))

    def add(self, account: str, value: bytes) -> int:
        with self._scope() as owned:
            query = self._query(account, owned)
            self._put(query, "kSecValueData", self._data(value, owned))
            self._put(
                query,
                "kSecAttrAccessible",
                self._constants["kSecAttrAccessibleWhenUnlockedThisDeviceOnly"],
            )
            return int(self.security.SecItemAdd(query, None))


class KeychainStore:
    """Device-only, unlocked Keychain credentials; reject every insecure fallback."""

    def __init__(self, backend: KeychainBackend | None = None) -> None:
        self.backend = backend if backend is not None else SecurityKeychain()

    @staticmethod
    def _account(account: str) -> None:
        if not account or "\x00" in account or len(account.encode("utf-8")) > 2048:
            raise BridgeError("KEYCHAIN_INVALID_DATA", "Identificador Keychain inválido")

    @staticmethod
    def _check(status: int) -> None:
        if status == 0:
            return
        if status == -25308:  # errSecInteractionNotAllowed
            raise BridgeError(
                "KEYCHAIN_LOCKED", "Desbloqueie o iPhone e execute Pyto em primeiro plano"
            )
        raise BridgeError(
            "KEYCHAIN_UNAVAILABLE", f"Keychain recusou acesso (OSStatus {status})"
        )

    def check_available(self) -> None:
        # A successful read query is evidence of callable APIs, not a successful
        # credential write. Enrollment verifies persistence by reading it back.
        self.get("__photointel_availability_probe__")

    def get(self, account: str) -> str | None:
        self._account(account)
        status, raw = self.backend.read(account)
        if status == -25300:  # errSecItemNotFound
            return None
        self._check(status)
        if not raw or len(raw) > 4096:
            raise BridgeError("KEYCHAIN_INVALID_DATA", "Credencial Keychain inválida")
        try:
            value = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise BridgeError(
                "KEYCHAIN_INVALID_DATA", "Credencial Keychain inválida"
            ) from exc
        if "\x00" in value:
            raise BridgeError("KEYCHAIN_INVALID_DATA", "Credencial Keychain inválida")
        return value

    def set(self, account: str, value: str) -> None:
        self._account(account)
        raw = value.encode("utf-8")
        if not raw or len(raw) > 4096 or "\x00" in value:
            raise BridgeError("KEYCHAIN_INVALID_DATA", "Credencial Keychain inválida")
        status = self.backend.update(account, raw)
        if status == -25300:
            status = self.backend.add(account, raw)
            if status == -25299:  # errSecDuplicateItem: another enrollment won the race.
                status = self.backend.update(account, raw)
        self._check(status)
        if self.get(account) != value:
            raise BridgeError(
                "KEYCHAIN_VERIFICATION_FAILED",
                "Credencial não foi confirmada no Keychain",
            )


@dataclass(frozen=True, repr=False)
class AccessCredentials:
    """Cloudflare edge identity, independent of the server's Bridge device identity."""

    client_id: str
    client_secret: str

    def __post_init__(self) -> None:
        for value, limit in ((self.client_id, 256), (self.client_secret, 1024)):
            if not 0 < len(value) <= limit or not all(33 <= ord(c) <= 126 for c in value):
                raise BridgeError(
                    "ACCESS_CREDENTIAL_INVALID", "Credencial Cloudflare Access inválida"
                )

    @staticmethod
    def account(origin: str) -> str:
        # Separate items prevent an edge identity from overwriting the device bearer.
        digest = hashlib.sha256(origin.encode("utf-8")).hexdigest()
        return "cloudflare-access:" + digest

    @classmethod
    def load(cls, store: KeychainStore, origin: str) -> AccessCredentials | None:
        raw = store.get(cls.account(origin))
        if raw is None:
            return None
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict) or set(payload) != {"id", "secret"}:
                raise ValueError("Invalid credential envelope")
            if not isinstance(payload["id"], str) or not isinstance(
                payload["secret"], str
            ):
                raise ValueError("Invalid credential values")
            return cls(payload["id"], payload["secret"])
        except (TypeError, ValueError) as exc:
            raise BridgeError(
                "ACCESS_CREDENTIAL_INVALID",
                "Reconfigure Service Auth usando o comando access",
            ) from exc

    def save(self, store: KeychainStore, origin: str) -> None:
        # One item makes rotation atomic at the Keychain boundary, then verifies it.
        store.set(
            self.account(origin),
            json.dumps({"id": self.client_id, "secret": self.client_secret}),
        )


def prompt_access_credentials() -> AccessCredentials:
    """Do not let getpass fall back to an echoed terminal or command-line secrets."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            client_id = getpass.getpass("Cloudflare Access Client ID (oculto): ")
            secret = getpass.getpass("Cloudflare Access Client Secret (oculto): ")
    except getpass.GetPassWarning as exc:
        raise BridgeError(
            "ACCESS_INPUT_UNAVAILABLE",
            "Console sem entrada protegida; "
            "nenhuma credencial foi solicitada em texto puro",
        ) from exc
    except (EOFError, KeyboardInterrupt) as exc:
        raise BridgeError(
            "ACCESS_INPUT_CANCELLED", "Configuração Service Auth cancelada"
        ) from exc
    return AccessCredentials(client_id, secret)


class KeywordWriter(Protocol):
    """Extension boundary; a future adapter must verify actual SDK/runtime support."""

    def read(self, local_identifier: str) -> list[str]: ...

    def apply_delta(
        self, local_identifier: str, add: list[str], remove: list[str]
    ) -> None: ...


class UnavailableKeywordWriter:
    def read(self, local_identifier: str) -> list[str]:
        raise BridgeError(
            "PHOTOKIT_WRITE_UNAVAILABLE", "Leitura de keywords não verificada neste Pyto"
        )

    def apply_delta(
        self, local_identifier: str, add: list[str], remove: list[str]
    ) -> None:
        raise BridgeError(
            "PHOTOKIT_WRITE_UNAVAILABLE",
            "Adaptador de escrita PhotoKit Beta não validado",
        )


class PhotoKitReader:
    def __init__(self) -> None:
        self.error: str | None = None
        self.asset_class: Any = None
        self.library_class: Any = None
        self.options_class: Any = None
        self.descriptor_class: Any = None
        self.resource_class: Any = None
        try:
            if sys.platform != "ios" and platform.system() != "Darwin":
                raise ImportError("PhotoKit requires iOS")
            ctypes.CDLL("/System/Library/Frameworks/Photos.framework/Photos")
            from rubicon.objc import ObjCClass  # type: ignore[import-not-found]

            self.asset_class = ObjCClass("PHAsset")
            self.library_class = ObjCClass("PHPhotoLibrary")
            self.options_class = ObjCClass("PHFetchOptions")
            self.descriptor_class = ObjCClass("NSSortDescriptor")
            self.resource_class = ObjCClass("PHAssetResource")
        except (ImportError, OSError, NameError, ValueError) as exc:
            self.error = type(exc).__name__

    def authorization(self) -> str:
        if self.library_class is None:
            return "unavailable"
        try:
            return AUTHORIZATION.get(
                int(self.library_class.authorizationStatus()), "unavailable"
            )
        except Exception:
            return "unavailable"

    def request_authorization(self) -> str:
        if self.library_class is None:
            raise BridgeError(
                "PHOTOKIT_PERMISSION_DENIED", "PhotoKit não está disponível neste runtime"
            )
        # Keep the public API callback alive until the permission sheet responds.
        try:
            from rubicon.objc import Block  # type: ignore[import-not-found]
        except ImportError as exc:
            raise BridgeError(
                "PHOTOKIT_PERMISSION_DENIED",
                "Rubicon Block não disponível; autorize Pyto em Ajustes",
            ) from exc
        result: list[int] = []

        def receive(status: int) -> None:
            result.append(int(status))

        callback = Block(receive, restype=None, argtypes=[ctypes.c_long])
        try:
            self.library_class.requestAuthorization_(callback)
        except (AttributeError, TypeError, ctypes.ArgumentError) as exc:
            raise BridgeError(
                "PHOTOKIT_PERMISSION_DENIED",
                "Solicitação não disponível; autorize Pyto em Ajustes",
            ) from exc
        deadline = time.monotonic() + 120
        while not result and time.monotonic() < deadline:
            time.sleep(0.1)
        if not result:
            raise BridgeError(
                "PHOTOKIT_PERMISSION_DENIED",
                "Permissão pendente; execute doctor novamente após responder",
            )
        return AUTHORIZATION.get(result[0], "unavailable")

    def capabilities(self) -> dict[str, Any]:
        authorization = self.authorization()
        available = authorization in {"authorized", "limited"}
        return {
            "level": "read_only" if available else "unavailable",
            "photokit_read": available,
            "keywords_read": False,
            "keywords_write": False,
            "authorization": authorization,
            "platform": platform.platform()[:128],
            "adapter": "pyto-readonly-v1",
            "reason": (
                "Keywords PhotoKit Beta não validadas em Pyto. "
                "Inventário usa somente APIs públicas estáveis."
            ),
        }

    def inventory(
        self, offset: int, limit: int, checkpoint: dict[str, Any]
    ) -> dict[str, Any]:
        if self.authorization() not in {"authorized", "limited"}:
            raise BridgeError(
                "PHOTOKIT_PERMISSION_DENIED", "Autorize acesso às fotos em Ajustes > Pyto"
            )
        options = self.options_class.new()
        options.sortDescriptors = [
            self.descriptor_class.sortDescriptorWithKey_ascending_("creationDate", True)
        ]
        collection = self.asset_class.fetchAssetsWithOptions_(options)
        count = int(collection.count)
        if checkpoint and checkpoint.get("total") != count:
            offset = 0  # An idempotent rescan avoids skipping items after a library edit.
        if offset > 0 and offset <= count and checkpoint.get("last_identifier"):
            observed = str(collection.objectAtIndex_(offset - 1).localIdentifier)
            if observed != checkpoint["last_identifier"]:
                offset = 0
        items: list[dict[str, Any]] = []
        for index in range(offset, min(offset + limit, count)):
            asset = collection.objectAtIndex_(index)
            timestamp = asset.creationDate
            captured = (
                datetime.fromtimestamp(
                    float(timestamp.timeIntervalSince1970), UTC
                ).isoformat()
                if timestamp
                else None
            )
            resources = self.resource_class.assetResourcesForAsset_(asset)
            filename = (
                str(resources.objectAtIndex_(0).originalFilename)
                if int(resources.count)
                else None
            )
            media = {1: "image", 2: "video"}.get(int(asset.mediaType), "other")
            items.append(
                {
                    "local_identifier": str(asset.localIdentifier),
                    "cloud_identifier": None,
                    "filename": filename,
                    "captured_at": captured,
                    "width": int(asset.pixelWidth),
                    "height": int(asset.pixelHeight),
                    "media_type": media,
                    "sha256": None,
                    "keywords": None,
                }
            )
        next_offset = offset + len(items)
        return {
            "items": items,
            "complete": next_offset >= count,
            "checkpoint": {
                "offset": next_offset,
                "total": count,
                "last_identifier": items[-1]["local_identifier"] if items else None,
            },
        }


def revision(values: list[str]) -> str:
    import unicodedata

    canonical = sorted(
        {unicodedata.normalize("NFC", value).strip() for value in values} - {""}
    )
    data = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def safe_keyword_plan(operation: dict[str, Any], before: list[str]) -> dict[str, Any]:
    payload = operation["payload"]
    if operation.get("status") != "claimed" or not operation.get("approved_at"):
        raise BridgeError("SYNC_CONFLICT", "Operação não aprovada ou não adquirida")
    if revision(before) != operation["expected_revision"]:
        raise BridgeError(
            "SYNC_CONFLICT", "Keywords mudaram; solicite nova prévia e aprovação"
        )
    additions, removals = set(payload["add"]), set(payload["remove"])
    if removals and (
        not payload["approve_removals"] or removals - set(payload["managed_keywords"])
    ):
        raise BridgeError(
            "SYNC_CONFLICT", "Tentativa de remover keywords não gerenciadas"
        )
    after = sorted((set(before) | additions) - removals)
    if revision(after) != operation["desired_revision"]:
        raise BridgeError("SYNC_VERIFICATION_FAILED", "Revisão desejada não confere")
    return {
        "before": before,
        "add": sorted(additions),
        "remove": sorted(removals),
        "after": after,
    }


class Client:
    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        access: AccessCredentials | None = None,
    ) -> None:
        parsed = urllib.parse.urlsplit(base_url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise BridgeError(
                "INVALID_BACKEND_URL", "Bridge exige URL HTTPS sem credenciais"
            )
        if parsed.query or parsed.fragment or parsed.path.rstrip("/"):
            raise BridgeError(
                "INVALID_BACKEND_URL", "Use somente a origem HTTPS do backend"
            )
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.access = access

    @staticmethod
    def _validate_path(path: str) -> None:
        parsed = urllib.parse.urlsplit(path)
        decoded = urllib.parse.unquote(parsed.path)
        if (
            parsed.scheme
            or parsed.netloc
            or parsed.fragment
            or not decoded.startswith("/v1/bridge/")
            or any(part in {".", ".."} for part in decoded.split("/"))
            or any(ord(char) < 32 or ord(char) == 127 for char in path)
            or "\\" in decoded
        ):
            raise BridgeError(
                "INVALID_BRIDGE_PATH", "Cliente Bridge permite somente /v1/bridge/*"
            )

    def request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self._validate_path(path)
        retry_safe = path.split("?", 1)[0] in {
            "/v1/bridge/status",
            "/v1/bridge/capabilities",
            "/v1/bridge/manifest",
            "/v1/bridge/operations/preview",
        } or path.endswith("/ack")
        for attempt in range(3 if retry_safe else 1):
            try:
                return self._request_once(method, path, body)
            except BridgeError as error:
                if (
                    not retry_safe
                    or attempt == 2
                    or error.code
                    not in {
                        "BACKEND_UNAVAILABLE",
                        "BACKEND_RATE_LIMITED",
                    }
                ):
                    raise
                time.sleep(0.5 * (2**attempt))
        raise BridgeError("BACKEND_UNAVAILABLE", "Backend indisponível")

    def _request_once(
        self, method: str, path: str, body: dict[str, Any] | None
    ) -> dict[str, Any]:
        self._validate_path(path)
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            if not all(33 <= ord(char) <= 126 for char in self.token):
                raise BridgeError("KEYCHAIN_INVALID_DATA", "Credencial Bridge inválida")
            headers["Authorization"] = "Bearer " + self.token
        if self.access:
            headers["CF-Access-Client-Id"] = self.access.client_id
            headers["CF-Access-Client-Secret"] = self.access.client_secret
        encoded = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            self.base_url + path, data=encoded, headers=headers, method=method
        )
        try:
            # TLS verification remains enabled. Reject redirects to prevent sending
            # credentials to an unexpected login page or a different host.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(
                    self,
                    req: Any,
                    fp: Any,
                    code: int,
                    msg: str,
                    response_headers: Any,
                    newurl: str,
                ) -> None:
                    return None

            opener = urllib.request.build_opener(NoRedirect)
            with opener.open(request, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise BridgeError(
                        "INVALID_RESPONSE", "Resposta do backend excede limite"
                    )
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise BridgeError("INVALID_RESPONSE", "Resposta JSON inválida")
                return data
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                location = exc.headers.get("Location", "") if exc.headers else ""
                destination = urllib.parse.urlsplit(location)
                is_access = (destination.hostname or "").endswith(
                    ".cloudflareaccess.com"
                ) or "/cdn-cgi/access/login" in destination.path
                raise BridgeError(
                    "CLOUDFLARE_ACCESS_REQUIRED"
                    if is_access
                    else "BACKEND_REDIRECT_BLOCKED",
                    "Configure Service Auth com access e confira a política /v1/bridge/*"
                    if is_access
                    else "Redirecionamento recusado; confira a origem HTTPS",
                ) from exc
            code = (
                "BACKEND_RATE_LIMITED"
                if exc.code == 429
                else "BACKEND_UNAVAILABLE"
                if exc.code >= 500
                else "BACKEND_REJECTED"
            )
            try:
                server_code = json.loads(exc.read(16384)).get("error", {}).get("code")
                if exc.code < 500 and exc.code != 429 and server_code:
                    code = str(server_code)
            except (ValueError, TypeError, AttributeError):
                pass
            raise BridgeError(
                code, f"Backend recusou operação (HTTP {exc.code})"
            ) from exc
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise BridgeError(
                "BACKEND_UNAVAILABLE",
                "Não foi possível acessar o backend; tente novamente",
            ) from exc


class Bridge:
    def __init__(self, config_path: Path) -> None:
        self.config_path = config_path
        self.config = json.loads(config_path.read_text()) if config_path.exists() else {}
        self.reader = PhotoKitReader()

    def save(self) -> None:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.config_path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(self.config, handle, ensure_ascii=False, indent=2)
        temporary.replace(self.config_path)

    def client(self) -> Client:
        url = Client(self.config.get("backend_url", "")).base_url
        store = KeychainStore()
        token = store.get(url)
        if not token:
            raise BridgeError(
                "DEVICE_NOT_ENROLLED",
                "Execute enroll com um código novo da interface web",
            )
        return Client(url, token, AccessCredentials.load(store, url))

    def configure_access(
        self,
        url: str,
        credentials: AccessCredentials,
    ) -> dict[str, Any]:
        origin = Client(url).base_url
        store = KeychainStore()
        store.check_available()
        credentials.save(store, origin)
        return {
            "backend_url": origin,
            "credential_stored": "keychain",
            "configured": True,
        }

    def enroll(self, url: str, code: str, name: str) -> dict[str, Any]:
        client = Client(url)
        store = KeychainStore()
        # Fail before consuming the code when the runtime cannot query the Keychain.
        store.check_available()
        client = Client(
            client.base_url, access=AccessCredentials.load(store, client.base_url)
        )
        result = client.request(
            "POST",
            "/v1/bridge/enroll",
            {
                "name": name,
                "code": code,
                "capabilities": self.reader.capabilities(),
            },
        )
        store.set(client.base_url, result["credential"])
        self.config.update(
            backend_url=client.base_url, device_id=result["device"]["id"], checkpoint={}
        )
        self.save()
        return {"device_id": result["device"]["id"], "credential_stored": "keychain"}

    def inventory(self, limit: int = 50, batches: int = 1) -> dict[str, Any]:
        client = self.client()
        caps = self.reader.capabilities()
        client.request("POST", "/v1/bridge/capabilities", caps)
        processed, complete = 0, False
        for _ in range(batches):
            checkpoint = self.config.get("checkpoint", {})
            batch = self.reader.inventory(
                int(checkpoint.get("offset", 0)), limit, checkpoint
            )
            response = client.request(
                "POST",
                "/v1/bridge/manifest",
                {
                    "items": batch["items"],
                    "checkpoint": json.dumps(batch["checkpoint"]),
                    "complete": batch["complete"],
                },
            )
            processed += response["accepted"]
            self.config["checkpoint"] = {} if batch["complete"] else batch["checkpoint"]
            # Advance only after the server durably accepted the inventory batch.
            self.save()
            complete = batch["complete"]
            if complete:
                break
        return {
            "accepted": processed,
            "complete": complete,
            "checkpoint": self.config["checkpoint"],
        }

    def sync(self, dry_run: bool = True) -> dict[str, Any]:
        client = self.client()
        caps = self.reader.capabilities()
        client.request("POST", "/v1/bridge/capabilities", caps)
        # This executable first adapter cannot write keywords. Do not claim operations,
        # fabricate acknowledgements or consume a pending operation on a read-only device.
        if not caps["keywords_read"] or not caps["keywords_write"]:
            return {
                "status": "read_only",
                "error_code": "PHOTOKIT_WRITE_UNAVAILABLE",
                "pending_preserved": True,
                "dry_run": dry_run,
                "reason": caps["reason"],
                "backend": client.request("GET", "/v1/bridge/status"),
                "operations": client.request(
                    "GET", "/v1/bridge/operations/preview?limit=20"
                ),
            }
        raise BridgeError(
            "PHOTOKIT_WRITE_UNAVAILABLE", "Escrita exige adaptador validado separado"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Photo Intelligence — Pyto Bridge")
    parser.add_argument(
        "--config",
        type=Path,
        default=Path.home() / "Documents" / "photointel-bridge.json",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("doctor")
    doctor.add_argument("--request-permission", action="store_true")
    sub.add_parser("capabilities")
    access_parser = sub.add_parser("access", help="Salvar Service Auth no Keychain")
    access_parser.add_argument("--url", required=True)
    enrollment = sub.add_parser("enroll")
    enrollment.add_argument("--url", required=True)
    enrollment.add_argument("--code", required=True)
    enrollment.add_argument("--name", default="iPhone Pyto")
    inventory = sub.add_parser("inventory")
    inventory.add_argument("--limit", type=int, default=50, choices=range(1, 101))
    inventory.add_argument("--batches", type=int, default=1, choices=range(1, 101))
    sub.add_parser("sync")
    sub.add_parser("preview")
    sub.add_parser("status")
    arguments = parser.parse_args(argv)
    try:
        bridge = Bridge(arguments.config)
        if arguments.command == "doctor":
            if arguments.request_permission:
                bridge.reader.request_authorization()
            try:
                KeychainStore().check_available()
                keychain_status = "query_available"
            except BridgeError as error:
                keychain_status = error.code
            result = {
                "capabilities": bridge.reader.capabilities(),
                "enrolled": bool(bridge.config.get("device_id")),
                "credential_storage": keychain_status,
                "credential_storage_backend": "Security.framework",
            }
        elif arguments.command == "capabilities":
            result = bridge.reader.capabilities()
        elif arguments.command == "access":
            # Validate the origin and storage before asking for either credential.
            origin = Client(arguments.url).base_url
            KeychainStore().check_available()
            result = bridge.configure_access(origin, prompt_access_credentials())
        elif arguments.command == "enroll":
            result = bridge.enroll(arguments.url, arguments.code, arguments.name)
        elif arguments.command == "inventory":
            result = bridge.inventory(arguments.limit, arguments.batches)
        elif arguments.command in {"sync", "preview"}:
            result = bridge.sync(dry_run=True)
        else:
            result = bridge.client().request("GET", "/v1/bridge/status")
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except BridgeError as exc:
        print(
            json.dumps(
                {"ok": False, "error": {"code": exc.code, "message": exc.message}},
                ensure_ascii=False,
            )
        )
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "BRIDGE_CONFIGURATION_INVALID",
                        "message": "Verifique configuração e compatibilidade do runtime",
                    },
                }
            )
        )
        return 1
    except Exception as exc:
        # Runtime Objective-C exceptions must remain structured and must not echo
        # native exception messages that can contain private metadata.
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "BRIDGE_RUNTIME_FAILURE",
                        "message": (
                            "Falha do runtime; execute doctor e confira "
                            "compatibilidade do Pyto"
                        ),
                        "exception_type": type(exc).__name__,
                    },
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
