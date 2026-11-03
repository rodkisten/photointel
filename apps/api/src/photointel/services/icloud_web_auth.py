"""Private, browser-driven Apple login with no persistent password or plaintext MFA staging.

This module handles the already configured iCloud account only. Cloud Run is
stateless: MFA state is sealed to the admin identity with the existing AES-256
session key and kept solely in the browser's memory for at most ten minutes.
Only a verified session is published through the fenced encrypted R2 store.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import re
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from photointel.config import Settings
from photointel.errors import AppError, ErrorCode
from photointel.services.ingestion import ICloudAdapter
from photointel.services.session_store import (
    encryption_key, pack_directory, session_directory, unpack_directory,
)

STAGE_SECONDS = 600
STAGE_MAX_BYTES = 390_000
TOKEN_MAX_CHARS = 750_000
CODE = re.compile(r"^[0-9]{6}$")
logging.getLogger("pyicloud_ipd").setLevel(logging.CRITICAL)
logging.getLogger("pyicloud_ipd.base").setLevel(logging.CRITICAL)
logging.getLogger("pyicloud_ipd.session").setLevel(logging.CRITICAL)
logging.getLogger("requests").setLevel(logging.CRITICAL)


def _aad(settings: Settings, email: str) -> bytes:
    return json.dumps(
        ["photointel-icloud-browser-login-v1", settings.icloud_account.casefold(), email.casefold()],
        separators=(",", ":"),
    ).encode()


def seal_pending(settings: Settings, email: str, directory: Path, mode: str) -> str:
    """Never expose Apple cookies or password; encrypt transient MFA cookies."""
    if mode not in {"2fa", "2sa"}:
        raise ValueError("Invalid MFA mode")
    archive = pack_directory(directory, min(settings.icloud_session_max_bytes, STAGE_MAX_BYTES))
    plaintext = json.dumps({
        "version": 1, "expires": int(time.time()) + STAGE_SECONDS, "mode": mode,
        "archive": base64.b64encode(archive).decode("ascii"),
    }, separators=(",", ":")).encode()
    nonce = os.urandom(12)
    result = base64.urlsafe_b64encode(
        nonce + AESGCM(encryption_key(settings)).encrypt(nonce, plaintext, _aad(settings, email))
    ).decode("ascii").rstrip("=")
    if len(result) > TOKEN_MAX_CHARS:
        raise AppError(ErrorCode.INVALID_REQUEST, "Sessão temporária Apple excede o limite", 413)
    return result


def open_pending(settings: Settings, email: str, challenge: str) -> tuple[bytes, str]:
    if not isinstance(challenge, str) or len(challenge) > TOKEN_MAX_CHARS or not re.fullmatch(r"[A-Za-z0-9_-]{32,}", challenge):
        raise AppError(ErrorCode.VERIFICATION_REQUIRED, "Sessão de verificação inválida", 422)
    try:
        data = base64.urlsafe_b64decode(challenge + "=" * (-len(challenge) % 4))
        content = AESGCM(encryption_key(settings)).decrypt(data[:12], data[12:], _aad(settings, email))
        item = json.loads(content)
        if item.get("version") != 1 or item.get("mode") not in {"2fa", "2sa"}:
            raise ValueError("unexpected state")
        expiry = item.get("expires")
        if type(expiry) is not int or not time.time() < expiry <= time.time() + STAGE_SECONDS:
            raise ValueError("expired")
        archive = base64.b64decode(item["archive"], validate=True)
        if len(archive) > STAGE_MAX_BYTES + 128 * 1024 + 10240:
            raise ValueError("oversized")
        return archive, item["mode"]
    except (ValueError, TypeError, KeyError, InvalidTag, UnicodeError, binascii.Error):
        raise AppError(
            ErrorCode.VERIFICATION_REQUIRED,
            "Código ou sessão de verificação expirado. Comece novamente com a senha.",
            422,
        ) from None


def _client(settings: Settings, directory: Path, password: str | None) -> Any:
    from pyicloud_ipd.base import PyiCloudService

    # Disable third-party debug/error loggers: they can include signed URLs,
    # Apple responses, account details or other credential-bearing text.
    for name in ("pyicloud_ipd", "pyicloud_ipd.base", "pyicloud_ipd.session",
                 "pyicloud_ipd.services", "requests", "urllib3"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    return PyiCloudService(
        "com", settings.icloud_account,
        (lambda: password) if password is not None else (lambda: None),
        cookie_directory=str(directory), http_timeout=20,
    )


def _libraries(client: Any) -> list[str]:
    return sorted({**client.photos.private_libraries, **client.photos.shared_libraries})


def _begin_sync(settings: Settings, email: str, password: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="photointel-icloud-web-login-") as temporary:
        directory = Path(temporary)
        os.chmod(directory, 0o700)
        client = None
        try:
            client = _client(settings, directory, password)
            if client.requires_2sa:
                is_2fa = bool(client.requires_2fa)
                mode = "2fa" if is_2fa else "2sa"
                if is_2fa:
                    # Apple sends a code to the user's trusted device.
                    try:
                        client.trigger_push_notification()
                    except Exception:
                        pass
                else:
                    devices = client.trusted_devices
                    if not devices or not client.send_verification_code(devices[0]):
                        raise AppError(
                            ErrorCode.VERIFICATION_REQUIRED,
                            "A Apple não conseguiu enviar o código ao dispositivo confiável.",
                            422,
                        )
                return {
                    "state": "verification_required",
                    "mode": mode,
                    "challenge": seal_pending(settings, email, directory, mode),
                    "expires_in": STAGE_SECONDS,
                    "message": "Digite o código enviado ao seu dispositivo Apple.",
                }
            libraries = _libraries(client)
            return {
                "state": "authenticated",
                "archive": pack_directory(directory, settings.icloud_session_max_bytes),
                "libraries": libraries,
            }
        except AppError:
            raise
        except Exception:
            raise AppError(
                ErrorCode.ICLOUD_ACCESS_DENIED,
                "A Apple recusou a senha ou não respondeu. Confira a senha e tente novamente.",
                422,
            ) from None
        finally:
            if client is not None:
                client.session.close()


def _finish_sync(settings: Settings, email: str, challenge: str, code: str) -> dict[str, Any]:
    archive, mode = open_pending(settings, email, challenge)
    with tempfile.TemporaryDirectory(prefix="photointel-icloud-web-mfa-") as temporary:
        directory = Path(temporary)
        os.chmod(directory, 0o700)
        unpack_directory(archive, directory, settings.icloud_session_max_bytes)
        client = None
        try:
            client = _client(settings, directory, None)
            if mode == "2fa":
                valid = client.validate_2fa_code(code)
            else:
                devices = client.trusted_devices
                valid = bool(devices) and client.validate_verification_code(devices[0], code)
            if not valid or client.requires_2sa:
                raise AppError(
                    ErrorCode.VERIFICATION_REQUIRED,
                    "Código inválido ou expirado. Verifique o código Apple e tente novamente.",
                    422,
                )
            # Rebuild service endpoints after the MFA handshake; in 1.32.3 a
            # resumed client can complete 2FA without initializing _webservices.
            client.authenticate()
            return {
                "state": "authenticated",
                "archive": pack_directory(directory, settings.icloud_session_max_bytes),
                "libraries": _libraries(client),
            }
        except AppError:
            raise
        except Exception:
            raise AppError(
                ErrorCode.VERIFICATION_REQUIRED,
                "A Apple não validou o código. Tente novamente ou reinicie a autenticação.",
                422,
            ) from None
        finally:
            if client is not None:
                client.session.close()


async def _publish(settings: Settings, result: dict[str, Any]) -> dict[str, Any]:
    if settings.icloud_session_backend != "encrypted_object":
        raise AppError(
            ErrorCode.INVALID_REQUEST,
            "Reautenticação web requer armazenamento criptografado de sessões",
            503,
        )
    library = settings.icloud_library
    if not library or library not in result["libraries"]:
        raise AppError(
            ErrorCode.ICLOUD_ACCESS_DENIED,
            "A biblioteca configurada não está acessível nesta conta Apple.",
            422,
        )
    target = settings.model_copy(update={"icloud_enabled": True})
    try:
        async with session_directory(target, require_existing=False) as directory:
            unpack_directory(result["archive"], directory, target.icloud_session_max_bytes)
            inspected = target.model_copy(update={"icloud_session_directory": directory})
            # Full library probe, no download, no job. Publication is aborted if
            # Apple has not yet granted access to the selected library.
            try:
                await asyncio.to_thread(ICloudAdapter(inspected).connect)
            except AppError:
                raise
            except Exception:
                raise AppError(
                    ErrorCode.ICLOUD_ACCESS_DENIED,
                    "A Apple não confirmou o acesso à biblioteca. Sessão anterior preservada.",
                    422,
                ) from None
    except AppError:
        raise
    except Exception:
        raise AppError(
            ErrorCode.STORAGE_UNAVAILABLE,
            "Não foi possível publicar a nova sessão criptografada. Verifique o armazenamento.",
            503,
        ) from None
    return {
        "state": "connected",
        "valid": True,
        "library": library,
        "checked_at": datetime.now(UTC).isoformat(),
        "session_published": True,
        "message": "Sessão iCloud renovada e publicada criptografada. Acesso à biblioteca confirmado.",
    }


def login_readiness(settings: Settings) -> dict[str, Any]:
    """Expose only safe readiness flags, never Apple credentials or key material."""
    if not settings.icloud_account or not settings.icloud_library:
        return {
            "ready": False,
            "code": "ICLOUD_ACCOUNT_NOT_CONFIGURED",
            "message": "Configure a conta e a biblioteca iCloud no ambiente de produção.",
        }
    if settings.icloud_session_backend != "encrypted_object":
        return {
            "ready": False,
            "code": "ICLOUD_SESSION_BACKEND_NOT_READY",
            "message": "Configure o backend de sessões criptografadas antes do login.",
        }
    try:
        encryption_key(settings)
    except AppError:
        if settings.icloud_session_key is not None:
            return {
                "ready": False,
                "code": "ICLOUD_SESSION_KEY_INVALID",
                "message": (
                    "A versão de ICLOUD_SESSION_KEY recebida pela API não contém "
                    "32 bytes em Base64. Confira a versão do Secret Manager e as "
                    "referências na API e no worker. Não use sua senha Apple nem "
                    "substitua a chave existente sem recuperar os snapshots antigos."
                ),
            }
        return {
            "ready": False,
            "code": "ICLOUD_SESSION_KEY_UNAVAILABLE",
            "message": (
                "A chave técnica AES do iCloud não chegou à API. Verifique a referência "
                "ao Secret Manager e as permissões do serviço no GCP. "
                "O tamanho da senha Apple não tem relação com essa chave."
            ),
        }
    return {
        "ready": True,
        "code": "READY",
        "message": "Tudo pronto para entrar na Conta Apple e confirmar o código de dois fatores.",
    }


async def start_login(settings: Settings, email: str, password: str) -> dict[str, Any]:
    # Check infrastructure *before* Apple receives the password and emits MFA.
    # The required 32 bytes are the AES session key, NOT the Apple password.
    state = login_readiness(settings)
    if not state["ready"]:
        raise AppError(
            state["code"], state["message"],
            409 if state["code"] == "ICLOUD_ACCOUNT_NOT_CONFIGURED" else 503,
        )
    if not isinstance(password, str) or not 1 <= len(password) <= 512:
        raise AppError(ErrorCode.INVALID_REQUEST, "Informe sua senha Apple", 422)
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_begin_sync, settings, email, password), timeout=75,
        )
    except TimeoutError:
        raise AppError(
            ErrorCode.ICLOUD_ACCESS_DENIED,
            "Tempo esgotado ao contatar a Apple. Tente novamente.",
            504,
        ) from None
    if result["state"] == "verification_required":
        return result
    return await _publish(settings, result)


async def verify_login(
    settings: Settings, email: str, challenge: str, code: str,
) -> dict[str, Any]:
    if not isinstance(code, str) or not CODE.fullmatch(code):
        raise AppError(ErrorCode.VERIFICATION_REQUIRED, "Digite o código Apple de 6 dígitos", 422)
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(_finish_sync, settings, email, challenge, code),
            timeout=75,
        )
    except TimeoutError:
        raise AppError(
            ErrorCode.VERIFICATION_REQUIRED,
            "Tempo esgotado ao confirmar o código com a Apple. Recomece o login.",
            504,
        ) from None
    return await _publish(settings, result)
