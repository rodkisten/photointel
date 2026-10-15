"""One-shot ingestion and manifests. Apple passwords never enter this service."""

import asyncio
import json
import os
import re
import shutil
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.config import Settings
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Asset,
    AssetResource,
    IngestionRun,
    Library,
    MetadataSnapshot,
    Setting,
    utcnow,
)
from photointel.services.identity import revision_hash
from photointel.services.jobs import enqueue_job
from photointel.services.runtime_settings import effective_settings

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"}
VIDEO_EXTENSIONS = {".mov", ".mp4", ".m4v"}
RAW_EXTENSIONS = {".dng", ".cr2", ".nef", ".arw", ".raf"}


def _state_path(settings: Settings) -> Path:
    return settings.icloud_session_directory / "photointel-auth-state.json"


def authentication_state(settings: Settings) -> dict[str, Any]:
    if not settings.icloud_enabled:
        return {
            "state": "not_configured",
            "valid": False,
            "reason": "ICLOUD_ENABLED=false; execute autenticação em terminal seguro",
        }
    if not settings.icloud_account:
        return {
            "state": "not_configured",
            "valid": False,
            "reason": "Configure ICLOUD_ACCOUNT no servidor",
        }
    # Cookie presence proves nothing about validity. Only a bounded live probe does.
    try:
        report = json.loads(_state_path(settings).read_text())
        checked = report.get("checked_at")
        from datetime import datetime

        moment = datetime.fromisoformat(checked) if isinstance(checked, str) else None
        fresh = moment is not None and timedelta(0) <= utcnow() - moment < timedelta(
            minutes=65
        )
        fresh = (
            fresh
            and report.get("account_fingerprint")
            == sha256(
                settings.icloud_account.encode(),
            ).hexdigest()
            and report.get("library") == settings.icloud_library
        )
        if fresh:
            return {
                "state": report.get("state", "unknown"),
                "valid": report.get("state") == "valid",
                "checked_at": checked,
                "reason": report.get(
                    "reason",
                    "Execute ingest verify para verificar",
                ),
            }
    except (OSError, ValueError, TypeError):
        pass
    return {
        "state": "verification_required",
        "valid": False,
        "reason": "Sessão precisa de verificação online; execute ingest verify",
    }


def record_authentication(settings: Settings, state: str, reason: str) -> None:
    directory = settings.icloud_session_directory
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    target = _state_path(settings)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "state": state,
                "reason": reason,
                "checked_at": utcnow().isoformat(),
                "account_fingerprint": sha256(
                    settings.icloud_account.encode()
                ).hexdigest(),
                "library": settings.icloud_library,
            }
        )
    )
    os.chmod(temporary, 0o600)
    temporary.replace(target)


def classify_icloud_failure(text: str) -> tuple[str, str]:
    lower = text.lower()
    if any(
        term in lower
        for term in (
            "2fa",
            "two-factor",
            "authentication",
            "password",
            "invalid session",
            "session expired",
        )
    ):
        return ErrorCode.ICLOUD_AUTH_EXPIRED, "Sessão expirada; autentique no terminal"
    if any(term in lower for term in ("429", "rate limit", "throttl")):
        return (
            ErrorCode.ICLOUD_RATE_LIMITED,
            "Apple limitou solicitações; aguarde e tente novamente",
        )
    return (
        ErrorCode.ICLOUD_ACCESS_DENIED,
        "Acesso iCloud indisponível; verifique sessão e biblioteca",
    )


async def _library(
    session: AsyncSession,
    source_type: str,
    identifier: str,
    name: str,
) -> Library:
    await session.execute(
        insert(Library)
        .values(
            id=uuid4(),
            source_type=source_type,
            source_identifier=identifier,
            name=name,
        )
        .on_conflict_do_nothing(
            index_elements=[
                Library.source_type,
                Library.source_identifier,
            ]
        )
    )
    row = await session.scalar(
        select(Library).where(
            Library.source_type == source_type,
            Library.source_identifier == identifier,
        )
    )
    assert row is not None
    return row


async def _upsert_asset(
    session: AsyncSession,
    library: Library,
    *,
    source_key: str,
    filename: str,
    revision: str,
    metadata: dict[str, Any],
    size: int | None,
    media_type: str = "image",
    captured_at: Any = None,
    added_at: Any = None,
    batch_id: UUID | None = None,
) -> tuple[Asset, bool]:
    identifier = uuid4()
    created = (
        await session.execute(
            insert(Asset)
            .values(
                id=identifier,
                library_id=library.id,
                source_asset_key=source_key,
                filename=filename,
                content_revision=revision,
                source_metadata=metadata,
                source_account=metadata.get("source_account"),
                filesize=size,
                media_type=media_type,
                captured_at=captured_at,
                added_at=added_at,
            )
            .on_conflict_do_nothing(
                index_elements=[Asset.library_id, Asset.source_asset_key]
            )
            .returning(Asset.id)
        )
    ).scalar_one_or_none()
    asset = await session.scalar(
        select(Asset)
        .where(
            Asset.library_id == library.id,
            Asset.source_asset_key == source_key,
        )
        .with_for_update()
    )
    assert asset is not None
    changed = created is not None or asset.content_revision != revision
    asset.filename = filename
    if size is not None:
        asset.filesize = size
    if captured_at is not None:
        asset.captured_at = captured_at
    if added_at is not None:
        asset.added_at = added_at
    asset.media_type = media_type
    asset.source_account = metadata.get("source_account")
    if changed:
        asset.content_revision = revision
        asset.source_metadata = metadata
        asset.ingestion_status = "pending"
        asset.classification_status = (
            "pending" if media_type == "image" else "not_applicable"
        )
    else:
        asset.source_metadata = {**asset.source_metadata, **metadata}
        if not metadata.get("representation_unavailable"):
            asset.source_metadata = {
                key: value
                for key, value in asset.source_metadata.items()
                if key != "representation_unavailable"
            }
    asset.visibility_status = "active"
    asset.missing_scan_count = 0
    if (changed or asset.ingestion_status != "completed") and not metadata.get(
        "representation_unavailable"
    ):
        await enqueue_job(
            session,
            "media_download",
            asset.id,
            {"content_revision": revision},
            f"media_download:{asset.id}:{revision}",
            batch_id,
        )
    return asset, created is not None


def fixture_content_hash(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


async def ingest_fixture_directory(
    session: AsyncSession,
    path: Path,
    limit: int = 100,
    *,
    process_inline: bool = False,
    batch_id: UUID | None = None,
) -> dict[str, Any]:
    settings = await effective_settings(session)
    root = path.resolve()
    library = await _library(
        session,
        "fixture",
        "procedural-demo-v1",
        "Biblioteca de demonstração",
    )
    library.last_attempted_scan = utcnow()
    run = IngestionRun(library_id=library.id, full_scan=False)
    session.add(run)
    imported = skipped = discovered = transferred = 0
    # Only filenames are read in bounded iteration; fixture roots are operator-controlled.
    for file in sorted(root.iterdir()):
        if discovered >= limit:
            break
        if (
            file.is_symlink()
            or not file.is_file()
            or file.suffix.lower() not in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
        ):
            continue
        discovered += 1
        size = file.stat().st_size
        if (
            size > settings.max_download_bytes
            or transferred + size > settings.max_run_download_bytes
        ):
            skipped += 1
            continue
        digest = await asyncio.to_thread(fixture_content_hash, file)
        canonical_root = (settings.temp_directory / "fixtures").resolve()
        canonical_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        canonical_path = canonical_root / file.name
        if file.resolve() != canonical_path:
            await asyncio.to_thread(shutil.copyfile, file, canonical_path)
        os.chmod(canonical_path, 0o600)
        asset, created = await _upsert_asset(
            session,
            library,
            source_key=file.name,
            filename=file.name,
            revision=digest,
            metadata={"fixture": True, "cache_relative_path": file.name},
            size=size,
            media_type="video" if file.suffix.lower() in VIDEO_EXTENSIONS else "image",
            batch_id=batch_id,
        )
        if process_inline:
            from photointel.services.duplicates import analyze_duplicates
            from photointel.services.media import process_asset

            await process_asset(session, asset, settings)
            await analyze_duplicates(session, asset)
        imported += int(created)
        skipped += int(not created)
        transferred += size
    run.discovered, run.imported, run.skipped = discovered, imported, skipped
    run.bytes_transferred = transferred
    run.status, run.finished_at = "completed", utcnow()
    library.last_successful_scan = utcnow()
    await session.flush()
    return {
        "run_id": str(run.id),
        "library_id": str(library.id),
        "discovered": discovered,
        "imported": imported,
        "skipped": skipped,
        "bytes_transferred": transferred,
    }


def _safe_session_directory(settings: Settings) -> None:
    directory = settings.icloud_session_directory
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    for file in directory.iterdir():
        if file.is_file():
            os.chmod(file, 0o600)


async def schedule_due_ingestion(session: AsyncSession) -> None:
    settings = await effective_settings(session)
    paused = await session.get(Setting, "ingestion_paused")
    if not settings.icloud_enabled or (paused and paused.value):
        return
    # A timestamp bucket makes independent scheduler replicas idempotent.
    bucket = int(utcnow().timestamp()) // (60 * settings.ingestion_interval_minutes)
    await enqueue_job(
        session,
        "icloud_discovery",
        payload={
            "source": "icloud",
            "limit": settings.ingestion_import_limit,
        },
        idempotency_key=f"scheduled:icloud:{bucket}",
    )


@dataclass(frozen=True)
class RemoteAsset:
    """Whitelisted snapshot; lazy downloader properties run in a thread."""

    source_key: str
    filename: str
    media_type: str
    original_size: int | None
    captured_at: datetime | None
    added_at: datetime | None
    dimensions: tuple[int, int] | None
    version: Any
    representation_size: int | None
    representation_checksum: str | None
    live_resources: tuple[tuple[str, int], ...]


class ICloudAdapter:
    """Version-guarded icloudpd 1.32.3 Python adapter.

    APIs verified against upstream v1.32.3 src/pyicloud_ipd/{base,services/photos,
    asset_version}.py. It exposes stable downloader IDs and representation sizes,
    unlike filename-only CLI parsing. This is unofficial and intentionally guarded.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client: Any = None
        self.library: Any = None

    def connect(self) -> list[str]:
        import importlib.metadata
        import logging

        try:
            if importlib.metadata.version("icloudpd") != "1.32.3":
                raise AppError(
                    ErrorCode.ICLOUD_ACCESS_DENIED,
                    "Adapter exige icloudpd==1.32.3; valide atualizações",
                )
            from pyicloud_ipd.base import PyiCloudService
        except ImportError as exc:
            raise AppError(
                ErrorCode.ICLOUD_ACCESS_DENIED,
                "Instale dependências: uv sync --group ingest",
                503,
            ) from exc
        # Third-party exception/debug logs can contain signed URLs and account data.
        for name in (
            "pyicloud_ipd",
            "pyicloud_ipd.base",
            "pyicloud_ipd.services.photos",
            "pyicloud_ipd.session",
            "urllib3",
            "requests",
        ):
            logging.getLogger(name).setLevel(logging.CRITICAL)
        _safe_session_directory(self.settings)
        self.client = PyiCloudService(
            "com",
            self.settings.icloud_account,
            lambda: None,
            cookie_directory=str(self.settings.icloud_session_directory),
            http_timeout=30,
        )
        if not self.client.data or self.client.requires_2fa or self.client.requires_2sa:
            record_authentication(
                self.settings,
                "expired",
                "Autentique e conclua 2FA no terminal",
            )
            raise AppError(
                ErrorCode.ICLOUD_AUTH_EXPIRED,
                "Sessão expirada; autentique no terminal",
                503,
            )
        libraries = {
            **self.client.photos.private_libraries,
            **self.client.photos.shared_libraries,
        }
        self.library = libraries.get(self.settings.icloud_library)
        if self.library is None:
            raise AppError(
                ErrorCode.ICLOUD_ACCESS_DENIED,
                "Biblioteca indisponível; execute ingest libraries",
                503,
            )
        record_authentication(
            self.settings,
            "valid",
            "Acesso à biblioteca verificado online",
        )
        _safe_session_directory(self.settings)
        return sorted(libraries)

    def assets(self, offset: int = 0) -> Any:
        album = self.library.all
        album.offset = offset
        return iter(album.photos)

    def describe(self, photo: Any) -> RemoteAsset:
        """Read remote objects only on the blocking-adapter thread boundary."""
        from pyicloud_ipd.item_type import AssetItemType

        media_type = "video" if photo.item_type == AssetItemType.MOVIE else "image"
        version = self.representation(photo) if media_type == "image" else None
        try:
            original_size = int(photo.size)
        except (KeyError, TypeError, ValueError):
            original_size = None
        try:
            width, height = (int(value) for value in photo.dimensions)
            dimensions = (width, height) if width > 0 and height > 0 else None
        except (KeyError, TypeError, ValueError):
            dimensions = None
        try:
            added_at = photo.added_date
        except (KeyError, TypeError, ValueError, OverflowError):
            added_at = None
        try:
            captured_at = photo.asset_date
        except (KeyError, TypeError, ValueError, OverflowError):
            captured_at = None
        live_resources = tuple(
            (key.name.lower(), int(resource.size))
            for key, resource in photo.versions.items()
            if type(key).__name__ == "LivePhotoVersionSize"
        )
        return RemoteAsset(
            source_key=str(photo.id),
            filename=str(photo.calculate_filename() or photo.filename)[:1024],
            media_type=media_type,
            original_size=original_size,
            captured_at=captured_at,
            added_at=added_at,
            dimensions=dimensions,
            version=version,
            representation_size=int(version.size) if version else None,
            representation_checksum=str(version.checksum) if version else None,
            live_resources=live_resources,
        )

    def representation(self, photo: Any) -> Any:
        from pyicloud_ipd.version_size import AssetVersionSize

        size = {
            "medium": AssetVersionSize.MEDIUM,
            "thumb": AssetVersionSize.THUMB,
            "original": AssetVersionSize.ORIGINAL,
        }[self.settings.download_representation]
        if (
            size == AssetVersionSize.ORIGINAL
            and not self.settings.allow_original_fallback
        ):
            raise AppError(
                ErrorCode.MEDIA_DOWNLOAD_FAILED,
                "Original exige ALLOW_ORIGINAL_FALLBACK=true explicitamente",
            )
        version = photo.versions.get(size)
        if version is None and self.settings.allow_original_fallback:
            version = photo.versions.get(AssetVersionSize.ORIGINAL)
        return version

    def download(self, photo: Any, version: Any, target: Path) -> int:
        if version.size <= 0 or version.size > self.settings.max_download_bytes:
            raise AppError(
                ErrorCode.MEDIA_DOWNLOAD_FAILED,
                "Representação excede limite por arquivo",
            )
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.is_file() and target.stat().st_size == version.size:
            return 0
        partial = target.with_suffix(".part")
        offset = partial.stat().st_size if partial.exists() else 0
        if offset >= version.size:
            partial.unlink()
            offset = 0
        transferred = 0
        response = photo.download(self.client.session, version.url, start=offset)
        try:
            if response.status_code in (401, 403, 429):
                code = {
                    401: ErrorCode.ICLOUD_AUTH_EXPIRED,
                    403: ErrorCode.ICLOUD_ACCESS_DENIED,
                    429: ErrorCode.ICLOUD_RATE_LIMITED,
                }[response.status_code]
                if response.status_code == 401:
                    record_authentication(
                        self.settings,
                        "expired",
                        "Autentique novamente no terminal",
                    )
                raise AppError(
                    code,
                    "Apple recusou o download; verifique sessão ou limite",
                    503,
                )
            response.raise_for_status()
            if offset and response.status_code != 206:
                offset = 0
            if response.status_code == 206:
                match = re.fullmatch(
                    r"bytes (\d+)-(\d+)/(\d+)",
                    response.headers.get("Content-Range", ""),
                )
                if not match:
                    raise AppError(
                        ErrorCode.MEDIA_DOWNLOAD_FAILED,
                        "Resposta parcial sem Content-Range válido",
                    )
                start, end, total = (int(value) for value in match.groups())
                if start != offset or total != version.size or not start <= end < total:
                    raise AppError(
                        ErrorCode.MEDIA_DOWNLOAD_FAILED,
                        "Resposta parcial não corresponde ao arquivo esperado",
                    )
            advertised = response.headers.get("Content-Length")
            if advertised and int(advertised) + offset > self.settings.max_download_bytes:
                raise AppError(
                    ErrorCode.MEDIA_DOWNLOAD_FAILED,
                    "Resposta excede o limite de download",
                )
            with partial.open("ab" if offset else "wb") as output:
                os.chmod(partial, 0o600)
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    if not chunk:
                        continue
                    transferred += len(chunk)
                    if transferred + offset > min(
                        version.size,
                        self.settings.max_download_bytes,
                    ):
                        raise AppError(
                            ErrorCode.MEDIA_DOWNLOAD_FAILED,
                            "Resposta excede o tamanho autorizado",
                        )
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if partial.stat().st_size != version.size:
                raise AppError(
                    ErrorCode.MEDIA_DOWNLOAD_FAILED,
                    "Download incompleto; parcial preservado para retomar",
                )
            partial.replace(target)
            return transferred
        finally:
            response.close()


def _next_photo(iterator: Any) -> Any:
    return next(iterator, None)


async def ingest_icloud(
    session: AsyncSession,
    settings: Settings,
    limit: int = 100,
    *,
    full_scan: bool = False,
    job_id: UUID | None = None,
    batch_id: UUID | None = None,
) -> dict[str, Any]:
    if not settings.icloud_enabled or not settings.icloud_account:
        raise AppError(
            ErrorCode.ICLOUD_ACCESS_DENIED,
            "Configure e habilite integração iCloud",
            503,
        )
    limit = min(max(1, limit), settings.ingestion_import_limit)
    identifier = sha256(
        f"{settings.icloud_account}:{settings.icloud_library}".encode(),
    ).hexdigest()
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {
            "key": int.from_bytes(bytes.fromhex(identifier)[:8], "big", signed=True),
        },
    )
    adapter = ICloudAdapter(settings)
    try:
        await asyncio.to_thread(adapter.connect)
    except AppError:
        raise
    except Exception as exc:
        code, reason = classify_icloud_failure(type(exc).__name__)
        await asyncio.to_thread(record_authentication, settings, "unavailable", reason)
        raise AppError(code, reason, 503) from exc
    library = await _library(session, "icloud", identifier, settings.icloud_library)
    library.last_attempted_scan = utcnow()
    run = IngestionRun(library_id=library.id, job_id=job_id, full_scan=False)
    session.add(run)
    # Rotating scans avoid assuming capture date equals addition date. Persisted
    # offset bounds each execution; complete cycles reconcile missing candidates.
    config = dict(library.configuration)
    offset = 0 if full_scan else int(config.get("scan_offset", 0))
    scan_token = str(config.get("scan_token") or uuid4())
    if full_scan:
        scan_token = str(uuid4())
    import itertools

    # Revisit a bounded head on every incremental run while rotating through older
    # capture dates. Backdated additions are eventually found by the deep cursor.
    head_limit = min(50, limit // 2) if offset and not full_scan else 0
    iterator = itertools.chain(
        ((photo, False) for photo in itertools.islice(adapter.assets(), head_limit)),
        ((photo, True) for photo in adapter.assets(offset)),
    )
    deep_count = 0
    count = imported = skipped = failed = transferred = 0
    exhausted = False
    while count < limit:
        entry = await asyncio.to_thread(_next_photo, iterator)
        if entry is None:
            exhausted = True
            break
        photo, from_deep_scan = entry
        count += 1
        deep_count += int(from_deep_scan)
        remote = await asyncio.to_thread(adapter.describe, photo)
        version = remote.version
        source = {
            "downloader_id": remote.source_key,
            "icloud_library": settings.icloud_library,
            "source_account": sha256(settings.icloud_account.encode()).hexdigest(),
            "scan_token": scan_token,
            "source_identity_kind": "icloudpd_not_phcloud",
            "representation": settings.download_representation,
            "live_photo": bool(remote.live_resources),
        }
        metadata_revision = revision_hash(
            {
                "id": remote.source_key,
                "original_bytes": remote.original_size,
                "representation_checksum": remote.representation_checksum,
                "representation_bytes": remote.representation_size,
            }
        )
        source_snapshot = {
            "filename": remote.filename,
            "original_bytes": remote.original_size,
            "captured_at": remote.captured_at.isoformat() if remote.captured_at else None,
            "added_at": remote.added_at.isoformat() if remote.added_at else None,
            "dimensions": remote.dimensions,
            "content_revision": metadata_revision,
        }
        source["metadata_revision"] = revision_hash(source_snapshot)
        identity_hash = sha256(remote.source_key.encode()).hexdigest()
        relative = f"{identity_hash}/{metadata_revision}.image"
        source["cache_relative_path"] = relative
        existing = await session.scalar(
            select(Asset).where(
                Asset.library_id == library.id,
                Asset.source_asset_key == remote.source_key,
            )
        )
        snapshot_changed = (
            existing is None
            or existing.source_metadata.get(
                "metadata_revision",
            )
            != source["metadata_revision"]
        )
        if (
            existing
            and existing.content_revision == metadata_revision
            and existing.ingestion_status == "completed"
        ):
            if snapshot_changed:
                session.add(
                    MetadataSnapshot(
                        asset_id=existing.id,
                        source="icloud",
                        revision_hash=source["metadata_revision"],
                        payload=source_snapshot,
                    )
                )
            existing.filename = remote.filename
            if remote.original_size is not None:
                existing.filesize = remote.original_size
            if remote.captured_at is not None:
                existing.captured_at = remote.captured_at
            if remote.added_at is not None:
                existing.added_at = remote.added_at
            if remote.dimensions:
                existing.width, existing.height = remote.dimensions
            existing.source_metadata = {**existing.source_metadata, **source}
            existing.visibility_status = "active"
            existing.missing_scan_count = 0
            skipped += 1
            continue
        if remote.media_type == "image" and version:
            if version.size > settings.max_download_bytes:
                source["representation_unavailable"] = "exceeds_download_limit"
            elif transferred + version.size > settings.max_run_download_bytes:
                count -= 1  # Resume from this asset in the next bounded run.
                deep_count -= int(from_deep_scan)
                break
            else:
                try:
                    target = (settings.icloud_download_directory / relative).resolve()
                    transferred += await asyncio.to_thread(
                        adapter.download,
                        photo,
                        version,
                        target,
                    )
                except Exception as exc:
                    code = (
                        exc.code
                        if isinstance(exc, AppError)
                        else ErrorCode.MEDIA_DOWNLOAD_FAILED
                    )
                    source["representation_unavailable"] = str(code)
                    failed += 1
                    # Let the durable discovery job retry. Already downloaded files
                    # are reused, while rolled-back catalog changes remain atomic.
                    raise AppError(
                        code,
                        "Falha ao baixar mídia; execução será retomada",
                        503,
                    ) from exc
        elif remote.media_type == "image":
            source["representation_unavailable"] = (
                "requested_representation_missing_no_fallback"
            )
        asset, created = await _upsert_asset(
            session,
            library,
            source_key=remote.source_key,
            filename=remote.filename,
            revision=metadata_revision,
            metadata=source,
            size=remote.original_size,
            media_type=remote.media_type,
            captured_at=remote.captured_at,
            added_at=remote.added_at,
            batch_id=batch_id,
        )
        if snapshot_changed:
            session.add(
                MetadataSnapshot(
                    asset_id=asset.id,
                    source="icloud",
                    revision_hash=source["metadata_revision"],
                    payload=source_snapshot,
                )
            )
        # Linked Live Photo video resources stay under this asset; no video
        # download is needed for v1 image inference.
        for size_name, byte_size in remote.live_resources:
            resource_type = f"source_live_video_{size_name}"
            linked = await session.scalar(
                select(AssetResource).where(
                    AssetResource.asset_id == asset.id,
                    AssetResource.resource_type == resource_type,
                    AssetResource.revision == metadata_revision,
                )
            )
            if linked is None:
                session.add(
                    AssetResource(
                        asset_id=asset.id,
                        resource_type=resource_type,
                        source_identifier=f"{remote.source_key}:{size_name}",
                        revision=metadata_revision,
                        byte_size=byte_size,
                        mime_type="video/quicktime",
                        status="catalog_only",
                    )
                )
        if remote.dimensions:
            asset.width, asset.height = remote.dimensions
        if source.get("representation_unavailable"):
            asset.ingestion_status = "unavailable"
            asset.last_error = str(source["representation_unavailable"])
        imported += int(created)
    if exhausted:
        # Only a successfully exhausted full rotation can mark an item as a
        # candidate. No scan can delete a metadata row, media, or an Apple asset.
        from sqlalchemy import update

        await session.execute(
            update(Asset)
            .where(
                Asset.library_id == library.id,
                Asset.source_metadata["scan_token"].as_string() != scan_token,
                Asset.visibility_status.not_in(("archived", "unavailable")),
            )
            .values(
                missing_scan_count=Asset.missing_scan_count + 1,
                visibility_status="missing_candidate",
            )
        )
        await session.execute(
            update(Asset)
            .where(
                Asset.library_id == library.id,
                Asset.visibility_status == "missing_candidate",
                Asset.missing_scan_count >= settings.reconcile_missing_scans,
            )
            .values(visibility_status="confirmed_missing")
        )
        config.update(scan_offset=0, scan_token=str(uuid4()))
        run.full_scan = True
    else:
        config.update(scan_offset=offset + deep_count, scan_token=scan_token)
    library.configuration = config
    library.last_successful_scan = utcnow()
    run.discovered, run.imported = count, imported
    run.failed, run.skipped = failed, skipped
    run.bytes_transferred = transferred
    run.status, run.finished_at = "completed", utcnow()
    await session.flush()
    return {
        "run_id": str(run.id),
        "discovered": count,
        "imported": imported,
        "failed": failed,
        "skipped": skipped,
        "bytes_transferred": transferred,
        "full_rotation_completed": exhausted,
        "next_offset": config["scan_offset"],
    }


async def run_scheduler() -> None:
    import signal
    import time

    from photointel.database import SessionLocal

    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stopped.set)
    last_cleanup = 0.0
    while not stopped.is_set():
        Path("/tmp/photointel-ingestion.heartbeat").write_text(str(time.time()))
        try:
            async with SessionLocal() as session:
                await schedule_due_ingestion(session)
                if time.monotonic() - last_cleanup >= 3600:
                    from photointel.services.media import cleanup_temporary_media

                    await cleanup_temporary_media(
                        session,
                        await effective_settings(session),
                    )
                    last_cleanup = time.monotonic()
                await session.commit()
        except Exception as exc:
            import structlog

            structlog.get_logger().warning(
                "ingestion_scheduler_unavailable", exception_type=type(exc).__name__
            )
        with suppress(TimeoutError):
            await asyncio.wait_for(stopped.wait(), 20)


if __name__ == "__main__":
    asyncio.run(run_scheduler())
