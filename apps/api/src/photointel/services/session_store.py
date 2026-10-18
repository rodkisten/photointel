"""Encrypted, fenced iCloud cookie snapshots for ephemeral Cloud Run tasks.

No database transaction is open while accessing object storage or Apple. Objects are
immutable; PostgreSQL compare-and-swap is the only authoritative mutable pointer.
"""

import asyncio
import base64
import binascii
import hashlib
import io
import json
import os
import stat
import tarfile
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any
from uuid import UUID, uuid4

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import or_, update
from sqlalchemy.dialects.postgresql import insert

from photointel.config import Settings
from photointel.database import SessionLocal
from photointel.errors import AppError
from photointel.models import SessionState
from photointel.storage import Storage, get_storage

VERSION = 1
MAX_FILES = 128


def _error(message: str, code: str = "ICLOUD_AUTH_EXPIRED") -> AppError:
    return AppError(code, message, 503)


def session_scope(settings: Settings) -> str:
    if not settings.icloud_account or not settings.icloud_library:
        raise _error("Configure a conta e a biblioteca antes de carregar a sessão")
    value = json.dumps(
        [settings.icloud_account.strip().casefold(), settings.icloud_library],
        separators=(",", ":"),
    )
    return hashlib.sha256(value.encode()).hexdigest()


def encryption_key(settings: Settings) -> bytes:
    try:
        raw = settings.icloud_session_key
        key = base64.b64decode(raw.get_secret_value() if raw else "", validate=True)
    except (ValueError, binascii.Error):
        raise _error("Chave de sessão inválida; verifique o Secret Manager") from None
    if len(key) != 32:
        raise _error("A chave de sessão deve conter 32 bytes em base64")
    return key


def pack_directory(directory: Path, limit: int) -> bytes:
    """Accept only bounded regular files; never follow links or archive device nodes."""
    if not directory.is_dir() or directory.is_symlink():
        raise _error("Diretório de sessão ausente ou inválido")
    stream = io.BytesIO()
    total = count = 0
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_symlink() or (not path.is_file() and not path.is_dir()):
                raise _error("A sessão contém um tipo de arquivo não permitido")
            if path.is_dir():
                continue
            count += 1
            if count > MAX_FILES:
                raise _error("A sessão excede o limite seguro")
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    raise _error("Arquivo de sessão não permitido")
                data = handle.read(limit + 1)
            total += len(data)
            if total > limit:
                raise _error("A sessão excede o limite seguro")
            info = tarfile.TarInfo(path.relative_to(directory).as_posix())
            info.size, info.mode = len(data), 0o600
            archive.addfile(info, io.BytesIO(data))
    if count == 0:
        raise _error("Sessão vazia; autentique pelo terminal")
    payload = stream.getvalue()
    if len(payload) > limit + MAX_FILES * 1024 + 10240:
        raise _error("Arquivo da sessão excede o limite seguro")
    return payload


def unpack_directory(payload: bytes, directory: Path, limit: int) -> None:
    if len(payload) > limit + MAX_FILES * 1024 + 10240:
        raise _error("Arquivo da sessão excede o limite seguro")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    total = 0
    seen: set[str] = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
            for index, member in enumerate(archive):
                name = PurePosixPath(member.name)
                if (
                    index >= MAX_FILES
                    or not member.isfile()
                    or name.is_absolute()
                    or any(part in {"", ".", ".."} for part in member.name.split("/"))
                    or "\\" in member.name
                    or len(member.name) > 512
                    or member.name in seen
                    or member.size < 0
                ):
                    raise _error("Arquivo da sessão contém uma entrada insegura")
                seen.add(member.name)
                total += member.size
                if total > limit:
                    raise _error("A sessão excede o limite seguro")
                target = directory.joinpath(*name.parts)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if target.is_symlink() or target.exists():
                    raise _error("Destino de sessão inesperado")
                source = archive.extractfile(member)
                if source is None:
                    raise _error("Arquivo de sessão inválido")
                with source, target.open("xb") as handle:
                    os.chmod(target, 0o600)
                    data = source.read(limit + 1)
                    if len(data) != member.size:
                        raise _error("Arquivo de sessão incompleto")
                    handle.write(data)
        if not seen:
            raise _error("Arquivo de sessão vazio")
    except (tarfile.TarError, OSError, ValueError):
        raise _error("Arquivo de sessão corrompido") from None


def encrypt_snapshot(
    payload: bytes, key: bytes, scope: str, generation: int, key_id: str
):
    header = {
        "version": VERSION,
        "scope": scope,
        "generation": generation,
        "key_id": key_id,
    }
    aad = json.dumps(header, sort_keys=True, separators=(",", ":")).encode()
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, payload, aad)
    return json.dumps(
        {
            **header,
            "nonce": base64.b64encode(nonce).decode(),
            "ciphertext": base64.b64encode(ciphertext).decode(),
        },
        separators=(",", ":"),
    ).encode()


def decrypt_snapshot(
    data: bytes, key: bytes, scope: str, generation: int, key_id: str, max_bytes: int
) -> bytes:
    if len(data) > 2 * (max_bytes + MAX_FILES * 1024 + 10240):
        raise _error("Snapshot de sessão excede o limite seguro")
    try:
        envelope = json.loads(data)
        expected = {
            "version": VERSION,
            "scope": scope,
            "generation": generation,
            "key_id": key_id,
        }
        if {name: envelope[name] for name in expected} != expected:
            raise ValueError("context mismatch")
        nonce = base64.b64decode(envelope["nonce"], validate=True)
        ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
        if len(nonce) != 12:
            raise ValueError("nonce size")
        aad = json.dumps(expected, sort_keys=True, separators=(",", ":")).encode()
        return AESGCM(key).decrypt(nonce, ciphertext, aad)
    except (ValueError, KeyError, TypeError, InvalidTag, binascii.Error):
        raise _error(
            "Snapshot de sessão corrompido ou chave/contexto incompatível"
        ) from None


@dataclass(frozen=True)
class SessionLease:
    scope: str
    owner: UUID
    token: int
    generation: int
    object_key: str | None
    sha256: str | None
    key_id: str | None
    updated_at: datetime


class SessionRepository:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def claim(self) -> SessionLease:
        scope, owner = session_scope(self.settings), uuid4()
        async with SessionLocal() as db, db.begin():
            await db.execute(
                insert(SessionState).values(scope_key=scope).on_conflict_do_nothing()
            )
            row = (
                await db.execute(
                    update(SessionState)
                    .where(
                        SessionState.scope_key == scope,
                        or_(
                            SessionState.lease_until.is_(None),
                            SessionState.lease_until < datetime.now(UTC),
                        ),
                    )
                    .values(
                        lease_owner=owner,
                        lease_token=SessionState.lease_token + 1,
                        lease_until=datetime.now(UTC)
                        + timedelta(seconds=self.settings.icloud_session_lease_seconds),
                    )
                    .returning(SessionState)
                )
            ).scalar_one_or_none()
            if row is None:
                raise _error(
                    "Outra execução está usando a sessão; tente novamente", "RATE_LIMITED"
                )
            object_key = None if row.revoked_at is not None else row.object_key
            return SessionLease(
                scope,
                owner,
                row.lease_token,
                row.generation,
                object_key,
                row.ciphertext_sha256,
                row.key_id,
                row.updated_at,
            )

    def _owned(self, lease: SessionLease):
        return (
            (SessionState.scope_key == lease.scope)
            & (SessionState.lease_owner == lease.owner)
            & (SessionState.lease_token == lease.token)
            & (SessionState.lease_until > datetime.now(UTC))
        )

    async def heartbeat(self, lease: SessionLease) -> bool:
        async with SessionLocal() as db, db.begin():
            result = await db.execute(
                update(SessionState)
                .where(self._owned(lease))
                .values(
                    lease_until=datetime.now(UTC)
                    + timedelta(seconds=self.settings.icloud_session_lease_seconds)
                )
                .returning(SessionState.scope_key)
            )
            return result.scalar_one_or_none() is not None

    async def publish(self, lease: SessionLease, key: str, digest: str) -> None:
        async with SessionLocal() as db, db.begin():
            result = await db.execute(
                update(SessionState)
                .where(
                    self._owned(lease),
                    SessionState.generation == lease.generation,
                )
                .values(
                    generation=lease.generation + 1,
                    object_key=key,
                    ciphertext_sha256=digest,
                    key_id=self.settings.icloud_session_key_id,
                    revoked_at=None,
                    last_error=None,
                    updated_at=datetime.now(UTC),
                )
                .returning(SessionState.scope_key)
            )
            if result.scalar_one_or_none() is None:
                raise _error(
                    "A sessão foi atualizada por outra execução; snapshot descartado",
                    "SYNC_CONFLICT",
                )

    async def release(self, lease: SessionLease) -> None:
        async with SessionLocal() as db, db.begin():
            await db.execute(
                update(SessionState)
                .where(
                    SessionState.scope_key == lease.scope,
                    SessionState.lease_owner == lease.owner,
                    SessionState.lease_token == lease.token,
                )
                .values(lease_owner=None, lease_until=None)
            )

    async def revoke(self, lease: SessionLease) -> None:
        async with SessionLocal() as db, db.begin():
            result = await db.execute(
                update(SessionState)
                .where(self._owned(lease))
                .values(
                    generation=SessionState.generation + 1,
                    object_key=None,
                    ciphertext_sha256=None,
                    revoked_at=datetime.now(UTC),
                )
                .returning(SessionState.scope_key)
            )
            if result.scalar_one_or_none() is None:
                raise _error("A posse da sessão expirou", "SYNC_CONFLICT")


@asynccontextmanager
async def session_directory(
    settings: Settings,
    *,
    require_existing: bool = True,
    repository: Any = None,
    storage: Storage | None = None,
) -> AsyncIterator[Path]:
    """Rehydrate, lease, encrypt refreshed cookies, fence publication, wipe plaintext.

    For native local development this preserves the original persistent directory.
    Cloud Run callers must select encrypted_object and use the yielded directory.
    """
    if settings.icloud_session_backend == "local":
        yield settings.icloud_session_directory
        return
    key = encryption_key(settings)
    repository = repository or SessionRepository(settings)
    storage = storage or get_storage()
    lease = await repository.claim()
    lost = asyncio.Event()

    async def renew() -> None:
        try:
            while True:
                await asyncio.sleep(max(5, settings.icloud_session_lease_seconds / 3))
                if not await repository.heartbeat(lease):
                    lost.set()
                    return
        except asyncio.CancelledError:
            return
        except Exception:
            lost.set()

    heartbeat = asyncio.create_task(renew())
    try:
        with tempfile.TemporaryDirectory(prefix="photointel-session-") as temporary:
            directory = Path(temporary)
            os.chmod(directory, 0o700)
            previous_payload = None
            if lease.object_key and require_existing:
                if lease.updated_at < datetime.now(UTC) - timedelta(
                    hours=settings.icloud_session_max_age_hours
                ):
                    raise _error(
                        "Sessão antiga; verifique e publique novamente pelo terminal"
                    )
                data = await asyncio.to_thread(storage.get, lease.object_key)
                if hashlib.sha256(data).hexdigest() != lease.sha256:
                    raise _error("Checksum do snapshot de sessão inválido")
                payload = decrypt_snapshot(
                    data,
                    key,
                    lease.scope,
                    lease.generation,
                    lease.key_id or "",
                    settings.icloud_session_max_bytes,
                )
                unpack_directory(payload, directory, settings.icloud_session_max_bytes)
                previous_payload = payload
            elif require_existing:
                raise _error("Sessão ausente ou revogada; autentique pelo terminal")
            yield directory
            if lost.is_set():
                raise _error(
                    "A posse da sessão expirou; publicação bloqueada", "SYNC_CONFLICT"
                )
            payload = pack_directory(directory, settings.icloud_session_max_bytes)
            if payload == previous_payload:
                return
            ciphertext = encrypt_snapshot(
                payload,
                key,
                lease.scope,
                lease.generation + 1,
                settings.icloud_session_key_id,
            )
            object_key = (
                f"sessions/{lease.scope}/{lease.generation + 1}/{uuid4().hex}.json"
            )
            await asyncio.to_thread(
                storage.put, object_key, ciphertext, "application/octet-stream"
            )
            await repository.publish(
                lease, object_key, hashlib.sha256(ciphertext).hexdigest()
            )
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        await repository.release(lease)
