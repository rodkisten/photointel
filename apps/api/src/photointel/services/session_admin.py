"""Terminal-only encrypted session administration, independent of API credentials."""

import argparse
import asyncio
import json
from pathlib import Path

from sqlalchemy import select

from photointel.config import get_settings
from photointel.database import SessionLocal
from photointel.errors import AppError
from photointel.models import SessionState
from photointel.services.ingestion import authentication_state
from photointel.services.session_store import (
    SessionRepository,
    pack_directory,
    session_directory,
    session_scope,
    unpack_directory,
)


async def run(command: str, confirmed: bool) -> dict[str, object]:
    settings = get_settings()
    if settings.icloud_session_backend != "encrypted_object":
        raise AppError(
            "INVALID_REQUEST", "Configure ICLOUD_SESSION_BACKEND=encrypted_object"
        )
    if command == "status":
        async with SessionLocal() as db:
            row = (
                await db.execute(
                    select(SessionState).where(
                        SessionState.scope_key == session_scope(settings)
                    )
                )
            ).scalar_one_or_none()
            return {
                "state": "available_unverified"
                if row and row.object_key and row.revoked_at is None
                else "missing_or_revoked",
                "generation": row.generation if row else 0,
                "remote_apple_verified": False,
                "snapshot_updated_at": row.updated_at.isoformat() if row else None,
            }
    if command == "publish":
        if not confirmed:
            raise AppError(
                "INVALID_REQUEST", "Use --confirm para publicar a sessão autenticada"
            )
        if not authentication_state(settings).get("valid"):
            raise AppError(
                "ICLOUD_AUTH_EXPIRED", "Execute icloud_admin verify no terminal primeiro"
            )
        payload = pack_directory(
            settings.icloud_session_directory, settings.icloud_session_max_bytes
        )
        async with session_directory(settings, require_existing=False) as destination:
            # A bootstrap replaces an old snapshot only after an explicit live probe.
            for path in sorted(destination.rglob("*"), reverse=True):
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    path.rmdir()
            unpack_directory(payload, destination, settings.icloud_session_max_bytes)
        return {"state": "published", "remote_apple_verified": False}
    if command == "download":
        if not confirmed:
            raise AppError(
                "INVALID_REQUEST", "Use --confirm para reidratar a sessão local"
            )
        destination = settings.icloud_session_directory
        if destination.exists() and any(destination.iterdir()):
            raise AppError("INVALID_REQUEST", "Use um diretório local de sessão vazio")
        async with session_directory(settings) as directory:
            payload = pack_directory(directory, settings.icloud_session_max_bytes)
            unpack_directory(payload, destination, settings.icloud_session_max_bytes)
        return {"state": "downloaded", "remote_apple_verified": False}
    if command == "verify":
        async with session_directory(settings) as directory:
            from photointel.services.ingestion import ICloudAdapter

            copied = settings.model_copy(
                update={"icloud_session_directory": Path(directory)}
            )
            adapter = ICloudAdapter(copied)
            await asyncio.to_thread(adapter.connect)
        return {"state": "valid", "remote_apple_verified": True}
    if not confirmed:
        raise AppError("INVALID_REQUEST", "Use --confirm para revogar a cópia persistida")
    repository = SessionRepository(settings)
    lease = await repository.claim()
    try:
        await repository.revoke(lease)
    finally:
        await repository.release(lease)
    return {"state": "revoked", "remote_apple_session_revoked": False}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sessões iCloud criptografadas para Cloud Run"
    )
    parser.add_argument(
        "command", choices=("publish", "verify", "status", "revoke", "download")
    )
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    try:
        print(
            json.dumps(asyncio.run(run(args.command, args.confirm)), ensure_ascii=False)
        )
    except AppError as exc:
        print(
            json.dumps(
                {"state": "unavailable", "error_code": exc.code, "message": exc.message},
                ensure_ascii=False,
            )
        )
        raise SystemExit(1) from None
    except Exception as exc:
        print(json.dumps({"state": "unavailable", "exception_type": type(exc).__name__}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
