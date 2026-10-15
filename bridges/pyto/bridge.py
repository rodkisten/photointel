#!/usr/bin/env python3
"""Photo Intelligence Pyto Bridge. JSON CLI, bounded PhotoKit inventory, no writes.

Runs directly in Pyto or is imported by a Shortcut/Pyto script. Python's standard
library is sufficient for the transport. PhotoKit uses Pyto's Rubicon ObjC bridge;
unsupported runtimes report capabilities rather than inventing success.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import platform
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

KEYCHAIN_SERVICE = "photo-intelligence-cloud.bridge"
AUTHORIZATION = {0: "not_determined", 1: "denied", 2: "denied", 3: "authorized", 4: "limited"}


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class KeychainStore:
    """Pyto ships the documented keychain module on supported iOS builds.

    Refuse plaintext fallback; an unavailable keychain is an actionable error.
    """

    def __init__(self) -> None:
        try:
            import keychain  # type: ignore[import-not-found]
        except ImportError as exc:
            raise BridgeError("KEYCHAIN_UNAVAILABLE", "Este Pyto não fornece o módulo keychain") from exc
        if not callable(getattr(keychain, "get_password", None)) or not callable(
            getattr(keychain, "set_password", None)
        ):
            raise BridgeError("KEYCHAIN_UNAVAILABLE", "API Keychain não compatível; nenhuma credencial foi gravada")
        self.module = keychain

    def get(self, account: str) -> str | None:
        try:
            value = self.module.get_password(KEYCHAIN_SERVICE, account)
        except Exception as exc:
            raise BridgeError("KEYCHAIN_UNAVAILABLE", "Não foi possível ler o Keychain") from exc
        return str(value) if value else None

    def set(self, account: str, value: str) -> None:
        try:
            self.module.set_password(KEYCHAIN_SERVICE, account, value)
        except Exception as exc:
            raise BridgeError("KEYCHAIN_UNAVAILABLE", "Não foi possível gravar no Keychain") from exc


class KeywordWriter(Protocol):
    """Extension boundary; a future adapter must verify actual SDK/runtime support."""

    def read(self, local_identifier: str) -> list[str]: ...

    def apply_delta(self, local_identifier: str, add: list[str], remove: list[str]) -> None: ...


class UnavailableKeywordWriter:
    def read(self, local_identifier: str) -> list[str]:
        raise BridgeError("PHOTOKIT_WRITE_UNAVAILABLE", "Leitura de keywords não verificada neste Pyto")

    def apply_delta(self, local_identifier: str, add: list[str], remove: list[str]) -> None:
        raise BridgeError("PHOTOKIT_WRITE_UNAVAILABLE", "Adaptador de escrita PhotoKit Beta não validado")


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
            return AUTHORIZATION.get(int(self.library_class.authorizationStatus()), "unavailable")
        except Exception:
            return "unavailable"

    def request_authorization(self) -> str:
        if self.library_class is None:
            raise BridgeError("PHOTOKIT_PERMISSION_DENIED", "PhotoKit não está disponível neste runtime")
        # Public API. The callback must stay alive until the system permission sheet responds.
        try:
            from rubicon.objc import Block  # type: ignore[import-not-found]
        except ImportError as exc:
            raise BridgeError("PHOTOKIT_PERMISSION_DENIED", "Rubicon Block não disponível; autorize Pyto em Ajustes") from exc
        result: list[int] = []

        def receive(status: int) -> None:
            result.append(int(status))

        callback = Block(receive, restype=None, argtypes=[ctypes.c_long])
        try:
            self.library_class.requestAuthorization_(callback)
        except (AttributeError, TypeError, ctypes.ArgumentError) as exc:
            raise BridgeError("PHOTOKIT_PERMISSION_DENIED", "Solicitação não disponível; autorize Pyto em Ajustes") from exc
        deadline = time.monotonic() + 120
        while not result and time.monotonic() < deadline:
            time.sleep(0.1)
        if not result:
            raise BridgeError("PHOTOKIT_PERMISSION_DENIED", "Permissão pendente; execute doctor novamente após responder")
        return AUTHORIZATION.get(result[0], "unavailable")

    def capabilities(self) -> dict[str, Any]:
        authorization = self.authorization()
        available = authorization in {"authorized", "limited"}
        return {
            "level": "read_only" if available else "unavailable",
            "photokit_read": available, "keywords_read": False, "keywords_write": False,
            "authorization": authorization, "platform": platform.platform()[:128],
            "adapter": "pyto-readonly-v1",
            "reason": "Keywords PhotoKit Beta não validadas em Pyto. Inventário usa somente APIs públicas estáveis.",
        }

    def inventory(self, offset: int, limit: int, checkpoint: dict[str, Any]) -> dict[str, Any]:
        if self.authorization() not in {"authorized", "limited"}:
            raise BridgeError("PHOTOKIT_PERMISSION_DENIED", "Autorize acesso às fotos em Ajustes > Pyto")
        options = self.options_class.new()
        options.sortDescriptors = [self.descriptor_class.sortDescriptorWithKey_ascending_("creationDate", True)]
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
            captured = datetime.fromtimestamp(float(timestamp.timeIntervalSince1970), timezone.utc).isoformat() if timestamp else None
            resources = self.resource_class.assetResourcesForAsset_(asset)
            filename = str(resources.objectAtIndex_(0).originalFilename) if int(resources.count) else None
            media = {1: "image", 2: "video"}.get(int(asset.mediaType), "other")
            items.append({
                "local_identifier": str(asset.localIdentifier), "cloud_identifier": None,
                "filename": filename, "captured_at": captured, "width": int(asset.pixelWidth),
                "height": int(asset.pixelHeight), "media_type": media,
                "sha256": None, "keywords": None,
            })
        next_offset = offset + len(items)
        return {"items": items, "complete": next_offset >= count,
                "checkpoint": {"offset": next_offset, "total": count,
                               "last_identifier": items[-1]["local_identifier"] if items else None}}


def revision(values: list[str]) -> str:
    import unicodedata
    canonical = sorted({unicodedata.normalize("NFC", value).strip() for value in values} - {""})
    data = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(data.encode()).hexdigest()


def safe_keyword_plan(operation: dict[str, Any], before: list[str]) -> dict[str, Any]:
    payload = operation["payload"]
    if operation.get("status") != "claimed" or not operation.get("approved_at"):
        raise BridgeError("SYNC_CONFLICT", "Operação não aprovada ou não adquirida")
    if revision(before) != operation["expected_revision"]:
        raise BridgeError("SYNC_CONFLICT", "Keywords mudaram; solicite nova prévia e aprovação")
    additions, removals = set(payload["add"]), set(payload["remove"])
    if removals and (not payload["approve_removals"] or removals - set(payload["managed_keywords"])):
        raise BridgeError("SYNC_CONFLICT", "Tentativa de remover keywords não gerenciadas")
    after = sorted((set(before) | additions) - removals)
    if revision(after) != operation["desired_revision"]:
        raise BridgeError("SYNC_VERIFICATION_FAILED", "Revisão desejada não confere")
    return {"before": before, "add": sorted(additions), "remove": sorted(removals), "after": after}


class Client:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise BridgeError("INVALID_BACKEND_URL", "Bridge exige URL HTTPS sem credenciais")
        if parsed.query or parsed.fragment or parsed.path.rstrip("/"):
            raise BridgeError("INVALID_BACKEND_URL", "Use somente a origem HTTPS do backend")
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        retry_safe = path.split("?", 1)[0] in {
            "/v1/bridge/status", "/v1/bridge/capabilities", "/v1/bridge/manifest",
            "/v1/bridge/operations/preview",
        } or path.endswith("/ack")
        for attempt in range(3 if retry_safe else 1):
            try:
                return self._request_once(method, path, body)
            except BridgeError as error:
                if (not retry_safe or attempt == 2 or error.code not in {
                    "BACKEND_UNAVAILABLE", "BACKEND_RATE_LIMITED",
                }):
                    raise
                time.sleep(0.5 * (2 ** attempt))
        raise BridgeError("BACKEND_UNAVAILABLE", "Backend indisponível")

    def _request_once(self, method: str, path: str,
                      body: dict[str, Any] | None) -> dict[str, Any]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        encoded = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base_url + path, data=encoded, headers=headers, method=method)
        try:
            # Default SSL verification stays enabled. Redirects are rejected so credentials
            # cannot be forwarded to an unexpected login page or a different host.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req: Any, fp: Any, code: int, msg: str,
                                     response_headers: Any, newurl: str) -> None:
                    return None
            opener = urllib.request.build_opener(NoRedirect)
            with opener.open(request, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise BridgeError("INVALID_RESPONSE", "Resposta do backend excede limite")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise BridgeError("INVALID_RESPONSE", "Resposta JSON inválida")
                return data
        except urllib.error.HTTPError as exc:
            code = ("BACKEND_RATE_LIMITED" if exc.code == 429 else
                    "BACKEND_UNAVAILABLE" if exc.code >= 500 else "BACKEND_REJECTED")
            try:
                server_code = json.loads(exc.read(16384)).get("error", {}).get("code")
                if exc.code < 500 and exc.code != 429 and server_code:
                    code = str(server_code)
            except (ValueError, TypeError, AttributeError):
                pass
            raise BridgeError(code, f"Backend recusou operação (HTTP {exc.code})") from exc
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise BridgeError("BACKEND_UNAVAILABLE", "Não foi possível acessar o backend; tente novamente") from exc


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
        url = self.config.get("backend_url", "")
        token = KeychainStore().get(url)
        if not token:
            raise BridgeError("DEVICE_NOT_ENROLLED", "Execute enroll com um código novo da interface web")
        return Client(url, token)

    def enroll(self, url: str, code: str, name: str) -> dict[str, Any]:
        store = KeychainStore()  # Verify secure storage availability before consuming a code.
        client = Client(url)
        result = client.request("POST", "/v1/bridge/enroll", {
            "name": name, "code": code, "capabilities": self.reader.capabilities(),
        })
        store.set(client.base_url, result["credential"])
        self.config.update(backend_url=client.base_url, device_id=result["device"]["id"], checkpoint={})
        self.save()
        return {"device_id": result["device"]["id"], "credential_stored": "keychain"}

    def inventory(self, limit: int = 50, batches: int = 1) -> dict[str, Any]:
        client = self.client()
        caps = self.reader.capabilities()
        client.request("POST", "/v1/bridge/capabilities", caps)
        processed, complete = 0, False
        for _ in range(batches):
            checkpoint = self.config.get("checkpoint", {})
            batch = self.reader.inventory(int(checkpoint.get("offset", 0)), limit, checkpoint)
            response = client.request("POST", "/v1/bridge/manifest", {
                "items": batch["items"], "checkpoint": json.dumps(batch["checkpoint"]),
                "complete": batch["complete"],
            })
            processed += response["accepted"]
            self.config["checkpoint"] = {} if batch["complete"] else batch["checkpoint"]
            self.save()  # Advance only after the server durably accepted the inventory batch.
            complete = batch["complete"]
            if complete:
                break
        return {"accepted": processed, "complete": complete, "checkpoint": self.config["checkpoint"]}

    def sync(self, dry_run: bool = True) -> dict[str, Any]:
        client = self.client()
        caps = self.reader.capabilities()
        client.request("POST", "/v1/bridge/capabilities", caps)
        # This executable first adapter cannot write keywords. Do not claim operations,
        # fabricate acknowledgements or consume a pending operation on a read-only device.
        if not caps["keywords_read"] or not caps["keywords_write"]:
            return {"status": "read_only", "error_code": "PHOTOKIT_WRITE_UNAVAILABLE",
                    "pending_preserved": True, "dry_run": dry_run,
                    "reason": caps["reason"], "backend": client.request("GET", "/v1/bridge/status"),
                    "operations": client.request("GET", "/v1/bridge/operations/preview?limit=20")}
        raise BridgeError("PHOTOKIT_WRITE_UNAVAILABLE", "Escrita exige adaptador validado separado")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Photo Intelligence — Pyto Bridge")
    parser.add_argument("--config", type=Path, default=Path.home() / "Documents" / "photointel-bridge.json")
    sub = parser.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("doctor")
    doctor.add_argument("--request-permission", action="store_true")
    sub.add_parser("capabilities")
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
                KeychainStore()
                keychain_status = "available"
            except BridgeError as error:
                keychain_status = error.code
            result = {"capabilities": bridge.reader.capabilities(),
                      "enrolled": bool(bridge.config.get("device_id")),
                      "credential_storage": keychain_status}
        elif arguments.command == "capabilities":
            result = bridge.reader.capabilities()
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
        print(json.dumps({"ok": False, "error": {"code": exc.code, "message": exc.message}}, ensure_ascii=False))
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"ok": False, "error": {"code": "BRIDGE_CONFIGURATION_INVALID", "message": "Verifique configuração e compatibilidade do runtime"}}))
        return 1
    except Exception as exc:
        # Runtime Objective-C exceptions must remain structured and must not echo
        # native exception messages that can contain private metadata.
        print(json.dumps({"ok": False, "error": {
            "code": "BRIDGE_RUNTIME_FAILURE",
            "message": "Falha do runtime; execute doctor e confira compatibilidade do Pyto",
            "exception_type": type(exc).__name__,
        }}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
