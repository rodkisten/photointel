"""Interactive Apple login and encrypted session publication; no ingestion runs."""

import argparse
import asyncio
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from photointel.config import Settings, get_settings
from photointel.database import SessionLocal, engine
from photointel.errors import AppError
from photointel.models import Setting
from photointel.services.ingestion import (
    ICloudAdapter,
    _safe_session_directory,
    authentication_state,
    record_authentication,
)
from photointel.services.runtime_settings import effective_settings
from photointel.services.session_store import (
    SessionRepository,
    encryption_key,
    pack_directory,
    session_directory,
    unpack_directory,
)


def authenticate(settings: Settings) -> None:
    if not sys.stdin.isatty():
        raise ValueError("Login Apple exige um terminal interativo; não use Actions")
    _safe_session_directory(settings)
    try:
        result = subprocess.run(
            [
                "icloudpd", "--username", settings.icloud_account,
                "--cookie-directory", str(settings.icloud_session_directory),
                "--password-provider", "console", "--mfa-provider", "console",
                "--auth-only",
            ],
            check=False,
        )
    finally:
        _safe_session_directory(settings)
    if result.returncode:
        record_authentication(settings, "expired", "Login Apple não foi concluído")
        raise ValueError("Login Apple não foi concluído; tente novamente no terminal")


def choose_library(available: list[str], selected: str) -> str:
    if selected:
        if selected not in available:
            raise ValueError("Biblioteca configurada não está disponível nesta conta")
        return selected
    if not available:
        raise ValueError("A Apple não retornou bibliotecas de fotos acessíveis")
    if len(available) == 1:
        return available[0]
    if not sys.stdin.isatty():
        raise ValueError("Escolha uma biblioteca pelo terminal interativo")
    for index, name in enumerate(available, 1):
        print(f"{index}. {name}")
    answer = input("Número da biblioteca: ").strip()
    if not answer.isdecimal() or not 1 <= int(answer) <= len(available):
        raise ValueError("Seleção de biblioteca inválida")
    return available[int(answer) - 1]


def inspect_access(settings: Settings, *, sample: bool = False) -> dict[str, Any]:
    adapter = ICloudAdapter(settings)
    libraries = adapter.connect()
    result: dict[str, Any] = {"state": "valid", "libraries": libraries}
    if sample:
        photo = next(adapter.assets(), None)
        result["asset_accessible"] = photo is not None
        if photo is not None:
            result["requested_representation_available"] = (
                adapter.representation(photo) is not None
            )
    return result


async def save_selection(settings: Settings) -> None:
    """Persist non-secret selectors, without enabling imports, GPU or schedules."""
    async with SessionLocal() as session, session.begin():
        for key in ("icloud_account", "icloud_library"):
            row = await session.get(Setting, key, with_for_update=True)
            if row is None:
                session.add(Setting(key=key, value=getattr(settings, key)))
            else:
                row.value = getattr(settings, key)


async def setup(settings: Settings) -> dict[str, Any]:
    """Stage privately, select library, verify, publish and re-read encrypted snapshot."""
    if not sys.stdin.isatty():
        raise ValueError("Setup exige terminal interativo para senha e 2FA")
    cloud = settings.icloud_session_backend == "encrypted_object"
    if cloud:
        encryption_key(settings)  # Fail before prompting Apple when the key is invalid.
    with tempfile.TemporaryDirectory(prefix="photointel-apple-login-") as temporary:
        directory = Path(temporary) if cloud else settings.icloud_session_directory
        staged = settings.model_copy(
            update={"icloud_session_directory": directory, "icloud_enabled": True}
        )
        await asyncio.to_thread(authenticate, staged)
        available = await asyncio.to_thread(
            ICloudAdapter(staged).connect, require_library=False
        )
        library = await asyncio.to_thread(choose_library, available, staged.icloud_library)
        staged = staged.model_copy(update={"icloud_library": library})
        result = await asyncio.to_thread(inspect_access, staged, sample=True)
        target = settings.model_copy(
            update={"icloud_library": library, "icloud_enabled": True}
        )
        if cloud:
            payload = pack_directory(directory, settings.icloud_session_max_bytes)
            async with session_directory(target, require_existing=False) as published:
                unpack_directory(
                    payload, published, settings.icloud_session_max_bytes
                )
            # Exercise the exact encrypted consumer path, not just cookie existence.
            async with session_directory(target) as restored:
                restored_settings = target.model_copy(
                    update={"icloud_session_directory": restored}
                )
                await asyncio.to_thread(inspect_access, restored_settings)
            await save_selection(target)
        result.update(
            library=library,
            session_published=cloud,
            ingestion_started=False,
            gpu_started=False,
        )
        return result


async def administer(arguments: argparse.Namespace) -> dict[str, Any]:
    settings = get_settings()
    if settings.icloud_session_backend == "encrypted_object":
        async with SessionLocal() as session:
            settings = await effective_settings(session)
    updates: dict[str, Any] = {"icloud_enabled": True}
    if arguments.account:
        updates["icloud_account"] = arguments.account.strip().casefold()
        if updates["icloud_account"] != settings.icloud_account.strip().casefold():
            updates["icloud_library"] = ""
    if arguments.library:
        updates["icloud_library"] = arguments.library
    settings = settings.model_copy(update=updates)
    if not settings.icloud_account:
        raise ValueError("Informe --account com o e-mail da conta Apple")
    if arguments.command in ("setup", "authenticate", "reauthenticate"):
        return await setup(settings)
    if arguments.command == "clear":
        if not arguments.confirm_clear_session:
            raise ValueError("Use --confirm-clear-session para revogar a sessão")
        if settings.icloud_session_backend == "encrypted_object":
            repository = SessionRepository(settings)
            lease = await repository.claim()
            try:
                await repository.revoke(lease)
            finally:
                await repository.release(lease)
        else:
            _safe_session_directory(settings)
            for path in settings.icloud_session_directory.iterdir():
                if path.is_file() and not path.is_symlink():
                    path.unlink()
        return {"state": "cleared", "remote_session_revoked": False}
    async with session_directory(settings) as directory:
        current = settings.model_copy(update={"icloud_session_directory": directory})
        if arguments.command == "status":
            return authentication_state(current)
        if arguments.command == "libraries":
            return {
                "libraries": await asyncio.to_thread(
                    ICloudAdapter(current).connect, require_library=False
                )
            }
        return await asyncio.to_thread(
            inspect_access, current, sample=arguments.command == "test"
        )


async def async_main(arguments: argparse.Namespace) -> int:
    try:
        result = await administer(arguments)
        if arguments.result_file:
            # This report contains selectors/status only, never credentials/cookies.
            with arguments.result_file.open("w", encoding="utf-8") as stream:
                arguments.result_file.chmod(0o600)
                json.dump(result, stream, ensure_ascii=False, indent=2)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except AppError as exc:
        print(json.dumps({"state": "unavailable", "error_code": exc.code,
                          "message": exc.message}, ensure_ascii=False))
        return 1
    except ValueError:
        print("Setup não concluído: confira conta, seleção de biblioteca e login Apple.")
        return 1
    except Exception as exc:
        print(json.dumps({"state": "unavailable", "exception_type": type(exc).__name__}))
        return 1
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "authenticate", "reauthenticate",
                        "verify", "libraries", "clear", "status", "test"))
    parser.add_argument("--account")
    parser.add_argument("--library")
    parser.add_argument("--result-file", type=Path)
    parser.add_argument("--confirm-clear-session", action="store_true")
    raise SystemExit(asyncio.run(async_main(parser.parse_args())))


if __name__ == "__main__":
    main()
