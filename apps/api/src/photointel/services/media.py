"""Bounded decoding and private derived files; originals are never modified."""

import asyncio
import hashlib
import io
import math
import os
import tempfile
import warnings
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import cv2
import imagehash
import numpy as np
from PIL import ExifTags, Image, ImageOps, UnidentifiedImageError

# HEIF support is required and supplied by pillow-heif wheels on amd64 and arm64.
from pillow_heif import register_heif_opener
from sqlalchemy import and_, exists, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from photointel.config import Settings
from photointel.errors import AppError, ErrorCode
from photointel.models import (
    Asset,
    AssetMetadata,
    AssetResource,
    DiscoveryManifest,
    Job,
    ObjectIntent,
    utcnow,
)
from photointel.services.leases import JobFence, LeaseLost, assert_job_fences
from photointel.storage import get_storage, object_key

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 100_000_000


@dataclass
class DerivedImage:
    variant: str
    data: bytes
    width: int
    height: int
    mime: str
    extension: str


@dataclass
class ProcessedMedia:
    width: int
    height: int
    sha256: str
    phash: str
    metadata: dict[str, Any]
    quality: dict[str, Any]
    variants: list[DerivedImage]


def _number(value: Any) -> float | None:
    try:
        result = float(value)
        return result if np.isfinite(result) else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _gps_coordinate(value: Any, reference: Any) -> float | None:
    if not isinstance(value, tuple) or len(value) != 3:
        return None
    parts = [_number(part) for part in value]
    if any(part is None for part in parts):
        return None
    degrees, minutes, seconds = (float(part) for part in parts if part is not None)
    coordinate = degrees + minutes / 60 + seconds / 3600
    return -coordinate if reference in ("S", "W") else coordinate


def decode_media(path: Path, settings: Settings) -> ProcessedMedia:
    if path.stat().st_size > settings.media_max_bytes:
        raise AppError(ErrorCode.MEDIA_DECODE_FAILED, "Imagem excede limite configurado")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as raw:
                raw.load()
                exif = raw.getexif()
                all_exif = dict(exif)
                with suppress(KeyError, TypeError, ValueError):
                    all_exif.update(exif.get_ifd(ExifTags.IFD.Exif))
                tags = {ExifTags.TAGS.get(k, str(k)): v for k, v in all_exif.items()}
                metadata: dict[str, Any] = {
                    "orientation": int(tags.get("Orientation", 1)),
                    "camera": str(tags.get("Model", ""))[:255] or None,
                    "lens": str(tags.get("LensModel", ""))[:255] or None,
                    "exposure": (
                        str(tags["ExposureTime"])[:64] if "ExposureTime" in tags else None
                    ),
                    "iso": int(tags["ISOSpeedRatings"])
                    if isinstance(tags.get("ISOSpeedRatings"), int)
                    else None,
                    "aperture": _number(tags.get("FNumber")),
                    "focal_length": _number(tags.get("FocalLength")),
                }
                try:
                    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
                    metadata["latitude"] = _gps_coordinate(gps.get(2), gps.get(1))
                    metadata["longitude"] = _gps_coordinate(gps.get(4), gps.get(3))
                except (KeyError, TypeError, ValueError):
                    pass
                if isinstance(tags.get("DateTimeOriginal"), str):
                    try:
                        parsed_date = datetime.strptime(
                            tags["DateTimeOriginal"],
                            "%Y:%m:%d %H:%M:%S",
                        )
                        offset = tags.get("OffsetTimeOriginal")
                        if isinstance(offset, str):
                            parsed_date = datetime.fromisoformat(
                                parsed_date.isoformat() + offset,
                            )
                            metadata["captured_at"] = parsed_date.astimezone(UTC)
                            metadata["timezone"] = offset
                        else:
                            metadata["additional_metadata"] = {
                                "capture_local_time_unresolved": parsed_date.isoformat(),
                                "note": "EXIF sem timezone; UTC não presumido",
                            }
                    except ValueError:
                        pass
                image = ImageOps.exif_transpose(raw).convert("RGB")
                image.info.clear()
    except (
        OSError,
        ValueError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise AppError(
            ErrorCode.MEDIA_DECODE_FAILED, "Imagem inválida ou codec indisponível", 422
        ) from exc
    small = image.copy()
    small.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    gray = cv2.cvtColor(np.asarray(small), cv2.COLOR_RGB2GRAY)
    brightness = float(np.mean(gray) / 255)
    contrast = float(np.std(gray) / 255)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    quality = {
        "resolution": image.width * image.height,
        "resolution_megapixels": round(image.width * image.height / 1_000_000, 3),
        "brightness": round(brightness, 4),
        "contrast": round(contrast, 4),
        "sharpness": round(sharpness, 3),
        "sharpness_laplacian_variance": round(sharpness, 3),
        "score": round(
            0.5 * min(image.width * image.height / 24_000_000, 1)
            + 0.3 * min(sharpness / 1000, 1)
            + 0.2 * (1 - abs(brightness - 0.5) * 2),
            4,
        ),
        "underexposed_fraction": round(float(np.mean(gray < 12)), 4),
        "overexposed_fraction": round(float(np.mean(gray > 243)), 4),
        "file_bytes": path.stat().st_size,
        "compression": "source_codec_dependent",
        "preview_codec_revision": "webp-avif-v1",
        "heuristic": True,
        "explanation": (
            "Índice heurístico = 50% resolução (24 MP), 30% nitidez (Laplaciano / 1000), "
            "20% brilho equilibrado. Não mede valor artístico."
        ),
    }
    variants = []
    sizes = {
        "thumbnail_small": settings.thumbnail_small_size,
        "thumbnail_medium": settings.thumbnail_medium_size,
        "preview_large": settings.preview_large_size,
        "inference_input": settings.inference_input_size,
    }
    for variant, size in sizes.items():
        derived = image.copy()
        derived.thumbnail((size, size), Image.Resampling.LANCZOS)
        # The stable resource names always retain a broadly supported fallback.
        # Quality is bounded by the user setting; thumbnails can be more compact
        # than a large photo displayed across the full viewport.
        quality = min(settings.image_quality, 80 if variant == "preview_large" else 76)
        output = io.BytesIO()
        try:
            derived.save(output, format="WEBP", quality=quality, method=6, exif=b"")
            extension, mime = "webp", "image/webp"
        except (KeyError, OSError, ValueError):
            output = io.BytesIO()
            derived.save(output, format="JPEG", quality=quality, optimize=True, exif=b"")
            extension, mime = "jpg", "image/jpeg"
        variants.append(
            DerivedImage(
                variant, output.getvalue(), derived.width, derived.height, mime, extension
            )
        )
        if variant == "inference_input":
            continue
        # AVIF is optional across CPU architectures/Pillow wheels. Failure
        # must never block the fallback image or the ingestion pipeline.
        avif = io.BytesIO()
        try:
            derived.save(
                avif,
                format="AVIF",
                quality=max(40, min(settings.image_quality - 24, 64)),
                speed=6,
                exif=b"",
            )
        except (KeyError, OSError, ValueError):
            continue
        # Retain an alternate only when it materially improves transfer size.
        # Some tiny or already compressed photographs get *larger* in AVIF.
        if avif.tell() and avif.tell() < len(output.getbuffer()) * 0.95:
            variants.append(
                DerivedImage(
                    f"{variant}_avif",
                    avif.getvalue(),
                    derived.width,
                    derived.height,
                    "image/avif",
                    "avif",
                )
            )
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return ProcessedMedia(
        image.width,
        image.height,
        digest.hexdigest(),
        str(imagehash.phash(image)),
        metadata,
        quality,
        variants,
    )


def source_path(asset: Asset, settings: Settings) -> Path:
    """Only a manifest-owned relative path inside the configured cache is accepted."""
    root = (
        settings.temp_directory / "fixtures"
        if asset.source_metadata.get("fixture", False)
        else settings.icloud_download_directory
    ).resolve()
    relative = asset.source_metadata.get("cache_relative_path")
    if not isinstance(relative, str):
        raise AppError(
            ErrorCode.MEDIA_DOWNLOAD_FAILED,
            "Manifesto sem representação local",
        )
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise AppError(
            ErrorCode.MEDIA_DOWNLOAD_FAILED,
            "Representação local indisponível; reexecute a ingestão",
        )
    return candidate


async def _current_asset(
    session: AsyncSession,
    asset: Asset,
    content_revision: str,
    representation_revision: str,
    job_fences: list[JobFence] | None,
) -> Asset:
    if job_fences:
        await assert_job_fences(session, job_fences)
    current = await session.scalar(
        select(Asset)
        .where(Asset.id == asset.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if current is None or (
        current.content_revision != content_revision
        or current.representation_revision != representation_revision
    ):
        raise LeaseLost("Asset revision changed during external processing")
    return current


async def _source_for_decode(
    session: AsyncSession,
    asset: Asset,
    settings: Settings,
    job_fences: list[JobFence] | None = None,
) -> Path:
    """Read a durable source descriptor, release SQL, then rehydrate ephemeral cache."""
    source = await session.scalar(
        select(AssetResource)
        .where(
            AssetResource.asset_id == asset.id,
            AssetResource.resource_type == "source_download",
            AssetResource.revision == asset.content_revision,
            AssetResource.status == "available",
        )
        .order_by(AssetResource.created_at.desc())
        .limit(1)
    )
    source_key = source.object_key if source else None
    source_hash = source.sha256 if source else None
    expected_size = source.byte_size if source else None
    expected_content, expected_revision = (
        asset.content_revision,
        asset.representation_revision,
    )
    await session.commit()
    try:
        cached = await asyncio.to_thread(source_path, asset, settings)
    except AppError:
        if not source_key:
            raise
    else:

        def verified_cache() -> bool:
            if expected_size is not None and cached.stat().st_size != expected_size:
                return False
            if source_hash is None:
                return True  # Fixture inputs have no persisted source object.
            digest = hashlib.sha256()
            with cached.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest() == source_hash

        if await asyncio.to_thread(verified_cache):
            return cached
        await asyncio.to_thread(cached.unlink, missing_ok=True)
        current = await _current_asset(
            session, asset, expected_content, expected_revision, job_fences
        )
        current.source_metadata = {
            **current.source_metadata,
            "last_cache_incident": {
                "code": "LOCAL_SHA256_MISMATCH",
                "detected_at": utcnow().isoformat(),
            },
        }
        await session.commit()
        if not source_key:
            raise AppError(
                ErrorCode.MEDIA_DOWNLOAD_FAILED,
                "Cache inválido sem representação persistida",
            )
    data = await asyncio.to_thread(get_storage().get, source_key)
    if len(data) > settings.max_download_bytes or (
        source_hash and hashlib.sha256(data).hexdigest() != source_hash
    ):
        raise AppError(
            ErrorCode.MEDIA_DOWNLOAD_FAILED,
            "Representação persistida inválida; reexecute o download",
        )
    root = settings.icloud_download_directory.resolve()
    relative = asset.source_metadata.get("cache_relative_path")
    if not isinstance(relative, str):
        raise AppError(ErrorCode.MEDIA_DOWNLOAD_FAILED, "Manifesto sem cache seguro")
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise AppError(ErrorCode.MEDIA_DOWNLOAD_FAILED, "Caminho de cache inválido")

    def write() -> None:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as handle:
                temporary = handle.name
                os.chmod(temporary, 0o600)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)

    await asyncio.to_thread(write)
    return target


async def process_asset(
    session: AsyncSession,
    asset: Asset,
    settings: Settings,
    *,
    job_fences: list[JobFence] | None = None,
) -> dict[str, Any]:
    if asset.media_type == "video":
        asset.ingestion_status = "completed"
        asset.classification_status = "not_applicable"
        return {"catalog_only": True}
    content_revision, previous_revision = (
        asset.content_revision,
        asset.representation_revision,
    )
    source = await _source_for_decode(session, asset, settings, job_fences)
    processed = await asyncio.to_thread(decode_media, source, settings)
    revision = processed.sha256
    # Record upload intents before transferring bytes. Final metadata and resources
    # share the caller's short fenced completion transaction.
    await store_variants(
        session, asset, processed.variants, revision, job_fences=job_fences
    )
    asset = await _current_asset(
        session, asset, content_revision, previous_revision, job_fences
    )
    if asset.source_metadata.get("fixture") or not asset.width or not asset.height:
        asset.width, asset.height = processed.width, processed.height
    if asset.sha256 and asset.sha256 != processed.sha256:
        from photointel.services.duplicates import invalidate_duplicate_memberships

        await invalidate_duplicate_memberships(session, asset.id)
    asset.sha256, asset.phash = processed.sha256, processed.phash
    asset.representation_revision = revision
    if asset.filesize is None or asset.source_metadata.get("fixture"):
        asset.filesize = processed.quality["file_bytes"]
    asset.quality = processed.quality
    if not asset.captured_at:
        asset.captured_at = processed.metadata.pop("captured_at", None)
    else:
        processed.metadata.pop("captured_at", None)
    row = await session.get(AssetMetadata, asset.id)
    if row is None:
        row = AssetMetadata(asset_id=asset.id)
        session.add(row)
    for key, value in processed.metadata.items():
        setattr(row, key, value)
    row.original_filename = asset.filename
    row.additional_metadata = {
        **(row.additional_metadata or {}),
        "downloaded_representation_bytes": processed.quality["file_bytes"],
        "source_original_bytes": asset.filesize,
        "source_original_width": asset.width,
        "source_original_height": asset.height,
        "processed_representation_width": processed.width,
        "processed_representation_height": processed.height,
    }
    asset.ingestion_status = "completed"
    await session.execute(
        update(DiscoveryManifest)
        .where(
            DiscoveryManifest.asset_id == asset.id,
            DiscoveryManifest.content_revision == content_revision,
        )
        .values(
            status="completed",
            failure_category=None,
            last_error=None,
            updated_at=utcnow(),
        )
    )
    asset.source_metadata = {
        **{
            key: value
            for key, value in asset.source_metadata.items()
            if key != "cache_retired_at"
        },
        "processed_at": utcnow().isoformat(),
    }
    asset.last_error = None
    await session.flush()
    return {
        "bytes_processed": processed.quality["file_bytes"],
        "variants": len(processed.variants),
        "representation_revision": revision,
    }


async def store_variants(
    session: AsyncSession,
    asset: Asset,
    variants: list[DerivedImage],
    revision: str,
    *,
    job_fences: list[JobFence] | None = None,
) -> None:
    """Transactional upload outbox: immutable keys, I/O outside SQL, fenced finalize."""
    content_revision, previous_revision = (
        asset.content_revision,
        asset.representation_revision,
    )
    await _current_asset(session, asset, content_revision, previous_revision, job_fences)
    prepared = []
    for variant in variants:
        digest = hashlib.sha256(variant.data).hexdigest()
        # Encoded bytes participate in identity: a stale upload cannot overwrite a
        # different image encoding produced by a newer lease owner.
        key = object_key(
            str(asset.id), f"{revision}:{digest}", variant.variant, variant.extension
        )
        prepared.append((variant, key, digest))
        await session.execute(
            insert(ObjectIntent)
            .values(
                asset_id=asset.id,
                job_id=job_fences[0][0] if job_fences else None,
                content_revision=content_revision,
                representation_revision=revision,
                object_key=key,
                sha256=digest,
                mime_type=variant.mime,
                byte_size=len(variant.data),
                status="pending",
                owner=job_fences[0][1] if job_fences else "inline",
                fence_token=job_fences[0][2] if job_fences else 0,
            )
            .on_conflict_do_nothing(index_elements=[ObjectIntent.object_key])
        )
    await session.commit()
    storage = get_storage()
    for variant, key, _ in prepared:
        await asyncio.to_thread(storage.put, key, variant.data, variant.mime)
    await _current_asset(session, asset, content_revision, previous_revision, job_fences)
    for variant, key, digest in prepared:
        statement = insert(AssetResource).values(
            asset_id=asset.id,
            resource_type=variant.variant,
            revision=revision,
            object_key=key,
            mime_type=variant.mime,
            byte_size=len(variant.data),
            width=variant.width,
            height=variant.height,
            sha256=digest,
            status="available",
            created_at=utcnow(),
        )
        await session.execute(
            statement.on_conflict_do_update(
                index_elements=[
                    AssetResource.asset_id,
                    AssetResource.resource_type,
                    AssetResource.revision,
                ],
                set_={
                    "object_key": key,
                    "mime_type": variant.mime,
                    "byte_size": len(variant.data),
                    "width": variant.width,
                    "height": variant.height,
                    "sha256": digest,
                    "status": "available",
                    "created_at": utcnow(),
                },
            )
        )
        await session.execute(
            update(ObjectIntent)
            .where(ObjectIntent.object_key == key)
            .values(status="committed", updated_at=utcnow())
        )


async def verify_media_stage(
    session: AsyncSession,
    asset: Asset,
    settings: Settings,
    stage: str,
    *,
    force: bool = False,
    job_fences: list[JobFence] | None = None,
) -> dict[str, Any]:
    """Check the actual stage output; explicit reindex can rebuild managed derivatives."""
    if asset.media_type == "video":
        return {"catalog_only": True, "skipped": True}
    if asset.ingestion_status != "completed":
        raise AppError(ErrorCode.MEDIA_DECODE_FAILED, "Processamento de mídia pendente")
    complete = False
    if stage == "hash_generate":
        try:
            complete = (
                asset.sha256 is not None
                and len(asset.sha256) == 64
                and asset.phash is not None
                and len(asset.phash) == 16
            )
            if complete:
                int(asset.sha256 or "", 16)
                int(asset.phash or "", 16)
        except ValueError:
            complete = False
    elif stage == "quality_analysis":
        fields = ("resolution", "brightness", "contrast", "sharpness", "score")
        complete = (
            all(
                isinstance(asset.quality.get(field), (int, float))
                and math.isfinite(asset.quality[field])
                for field in fields
            )
            and asset.quality.get("heuristic") is True
        )
    elif stage == "thumbnail_generate":
        rows = list(
            (
                await session.scalars(
                    select(AssetResource).where(
                        AssetResource.asset_id == asset.id,
                        AssetResource.revision == asset.representation_revision,
                        AssetResource.resource_type.in_(
                            (
                                "thumbnail_small",
                                "thumbnail_medium",
                                "preview_large",
                            )
                        ),
                        AssetResource.status == "available",
                    )
                )
            ).all()
        )
        complete = len(rows) == 3 and all(row.object_key for row in rows)
        if complete:
            await session.commit()
            complete = all(
                await asyncio.gather(
                    *[
                        asyncio.to_thread(get_storage().exists, str(row.object_key))
                        for row in rows
                    ]
                )
            )
    else:
        raise ValueError("Unsupported media stage")
    if complete and not force:
        return {
            "verified": True,
            "shared_decode": True,
            "verification": "private_objects"
            if stage == "thumbnail_generate"
            else "persisted_metrics",
            "skipped": True,
        }
    await session.commit()
    try:
        await asyncio.to_thread(source_path, asset, settings)
    except AppError:
        if stage == "hash_generate":
            raise AppError(
                ErrorCode.MEDIA_DECODE_FAILED,
                "Cache retirado: hash preservado; representação não foi relida",
                409,
            ) from None
        # Prefer the existing retained preview when available; if both the
        # ephemeral cache and preview are absent, process_asset can still
        # restore the immutable source_download object from private R2.
        if stage == "thumbnail_generate":
            preview = await session.scalar(
                select(AssetResource.id).where(
                    AssetResource.asset_id == asset.id,
                    AssetResource.revision == asset.representation_revision,
                    AssetResource.resource_type == "preview_large",
                    AssetResource.status == "available",
                ).limit(1)
            )
            if preview is not None:
                return await rebuild_from_preview(
                    session, asset, settings, stage, job_fences=job_fences
                )
            source = await session.scalar(
                select(AssetResource.id).where(
                    AssetResource.asset_id == asset.id,
                    AssetResource.revision == asset.content_revision,
                    AssetResource.resource_type == "source_download",
                    AssetResource.status == "available",
                ).limit(1)
            )
            if source is not None:
                result = await process_asset(
                    session, asset, settings, job_fences=job_fences
                )
                return {**result, "regenerated": True, "source": "durable_source"}
            raise AppError(
                ErrorCode.MEDIA_DOWNLOAD_FAILED,
                "Não há prévia nem origem persistida. Refaça o download iCloud.",
                409,
                {"reason": "SOURCE_NOT_RETAINED"},
            )
        return await rebuild_from_preview(
            session, asset, settings, stage, job_fences=job_fences
        )
    result = await process_asset(session, asset, settings, job_fences=job_fences)
    return {**result, "regenerated": True}


async def rebuild_from_preview(
    session: AsyncSession,
    asset: Asset,
    settings: Settings,
    stage: str,
    *,
    job_fences: list[JobFence] | None = None,
) -> dict[str, Any]:
    """Rebuild derived thumbnails/metrics without changing source identity or EXIF."""
    preview = await session.scalar(
        select(AssetResource).where(
            AssetResource.asset_id == asset.id,
            AssetResource.revision == asset.representation_revision,
            AssetResource.resource_type == "preview_large",
            AssetResource.status == "available",
        )
    )
    if preview is None or not preview.object_key:
        raise AppError(
            ErrorCode.MEDIA_DECODE_FAILED,
            "Preview e cache indisponíveis; restaure o storage privado",
            409,
        )
    expected_content, expected_revision = (
        asset.content_revision,
        asset.representation_revision,
    )
    key = preview.object_key
    await session.commit()
    data = await asyncio.to_thread(get_storage().get, key)
    if len(data) > settings.media_max_bytes:
        raise AppError(ErrorCode.MEDIA_DECODE_FAILED, "Preview excede limite configurado")
    await asyncio.to_thread(
        settings.temp_directory.mkdir,
        parents=True,
        exist_ok=True,
        mode=0o700,
    )

    def decode_preview() -> ProcessedMedia:
        with tempfile.NamedTemporaryFile(
            dir=settings.temp_directory,
            suffix=".image",
        ) as handle:
            os.chmod(handle.name, 0o600)
            handle.write(data)
            handle.flush()
            return decode_media(Path(handle.name), settings)

    processed = await asyncio.to_thread(decode_preview)
    if stage == "thumbnail_generate":
        await store_variants(
            session,
            asset,
            [
                variant
                for variant in processed.variants
                if variant.variant != "preview_large"
            ],
            asset.representation_revision,
            job_fences=job_fences,
        )
        # A retained WebP preview is sufficient for progressive optimization.
        # The original content revision and EXIF are not altered.
        asset.quality = {
            **(asset.quality or {}),
            "preview_codec_revision": "webp-avif-v1",
        }
    else:
        asset = await _current_asset(
            session, asset, expected_content, expected_revision, job_fences
        )
        asset.quality = {
            **processed.quality,
            "analysis_source": "retained_preview",
            "analysis_input_revision": asset.representation_revision,
        }
    return {
        "regenerated": True,
        "source": "retained_preview",
        "source_identity_preserved": True,
        "bytes_processed": len(data),
    }


async def cleanup_temporary_media(
    session: AsyncSession,
    settings: Settings,
    limit: int = 100,
) -> dict[str, int]:
    """Retire processed temporary inputs under durable asset leases, never originals.

    A current retained preview must survive HEAD before temporary bytes are removed.
    Retiring rows are retried after crashes. Network and filesystem operations do
    not retain SQL connections, and every candidate is bounded and revision checked.
    """
    from datetime import timedelta

    from photointel.services.leases import acquire_lease, assert_lease, release_lease

    cutoff = datetime.now(UTC) - timedelta(hours=settings.temporary_retention_hours)
    preview = aliased(AssetResource)
    active_job = exists(
        select(Job.id).where(
            Job.asset_id == Asset.id,
            Job.status.in_(("running", "preparing")),
            Job.lease_until > utcnow(),
        )
    )
    eligibility = or_(
        and_(
            AssetResource.resource_type == "inference_input",
            AssetResource.revision == Asset.representation_revision,
            or_(
                Asset.classification_status.in_(("not_configured", "not_applicable")),
                and_(
                    Asset.classification_status == "completed",
                    Asset.last_successful_inference.is_not(None),
                ),
            ),
        ),
        and_(
            AssetResource.resource_type == "source_download",
            AssetResource.revision == Asset.content_revision,
            Asset.classification_status.in_(
                ("completed", "not_configured", "not_applicable")
            ),
        ),
    )
    rows = (
        (
            await session.execute(
                select(
                    AssetResource.id,
                    AssetResource.asset_id,
                    AssetResource.object_key,
                    AssetResource.revision,
                    AssetResource.resource_type,
                    Asset.content_revision,
                    Asset.representation_revision,
                    preview.object_key.label("preview_key"),
                )
                .join(Asset, Asset.id == AssetResource.asset_id)
                .join(
                    preview,
                    and_(
                        preview.asset_id == Asset.id,
                        preview.revision == Asset.representation_revision,
                        preview.resource_type == "preview_large",
                        preview.status == "available",
                    ),
                )
                .where(
                    eligibility,
                    AssetResource.status.in_(("available", "retiring")),
                    AssetResource.created_at < cutoff,
                    Asset.ingestion_status == "completed",
                    ~active_job,
                )
                .order_by(AssetResource.created_at)
                .limit(min(1000, max(1, limit)))
            )
        )
        .mappings()
        .all()
    )
    await session.commit()
    objects = caches = failures = 0
    owner = f"retention:{uuid4()}"
    for descriptor in rows:
        lease_key = f"asset:{descriptor['asset_id']}"
        token = await acquire_lease(
            session, lease_key, owner, max(600, settings.job_lease_seconds)
        )
        await session.commit()
        if token is None:
            continue
        try:
            preview_key = descriptor["preview_key"]
            if not preview_key or not await asyncio.to_thread(
                get_storage().exists, preview_key
            ):
                continue
            # The lease prevents a worker from entering this asset's I/O stage.
            await assert_lease(session, lease_key, owner, token)
            current = await session.scalar(
                select(Asset)
                .where(
                    Asset.id == descriptor["asset_id"],
                    Asset.content_revision == descriptor["content_revision"],
                    Asset.representation_revision
                    == descriptor["representation_revision"],
                    Asset.ingestion_status == "completed",
                    ~active_job,
                )
                .with_for_update()
            )
            resource = await session.get(
                AssetResource, descriptor["id"], with_for_update=True
            )
            if (
                current is None
                or resource is None
                or resource.status not in ("available", "retiring")
                or resource.object_key != descriptor["object_key"]
            ):
                await session.rollback()
                continue
            resource.status = "retiring"
            await session.commit()
            if descriptor["object_key"]:
                await asyncio.to_thread(get_storage().delete, descriptor["object_key"])
            if descriptor["resource_type"] == "source_download":
                try:
                    cached = await asyncio.to_thread(source_path, current, settings)
                except AppError:
                    cached = None
                if cached and not current.source_metadata.get("fixture"):
                    await asyncio.to_thread(cached.unlink, missing_ok=True)
                    caches += 1
            await assert_lease(session, lease_key, owner, token)
            await session.execute(
                update(AssetResource)
                .where(
                    AssetResource.id == descriptor["id"],
                    AssetResource.object_key == descriptor["object_key"],
                    AssetResource.status == "retiring",
                )
                .values(status="expired")
            )
            await session.execute(
                update(ObjectIntent)
                .where(
                    ObjectIntent.object_key == descriptor["object_key"],
                    ObjectIntent.status == "committed",
                )
                .values(status="deleted", updated_at=utcnow())
            )
            await session.commit()
            objects += 1
        except Exception:
            # Retry the retiring intent on the next finite maintenance execution.
            await session.rollback()
            failures += 1
        finally:
            await release_lease(session, lease_key, owner, token)
            await session.commit()
    return {
        "temporary_objects_deleted": objects,
        "managed_download_caches_deleted": caches,
        "temporary_cleanup_failures": failures,
    }


async def reconcile_orphan_objects(
    session: AsyncSession,
    *,
    limit: int = 100,
    grace_hours: int = 24,
) -> dict[str, int]:
    """Reconcile only recorded managed upload intents after a conservative grace.

    Never enumerate and delete arbitrary bucket objects. A live worker's intent or
    any key referenced by the catalog is excluded even when its upload is old.
    """
    from datetime import timedelta

    cutoff = utcnow() - timedelta(hours=max(1, grace_hours))
    referenced = exists(
        select(AssetResource.id).where(
            AssetResource.object_key == ObjectIntent.object_key,
            AssetResource.status.in_(("available", "retiring")),
        )
    )
    active = exists(
        select(Job.id).where(
            Job.id == ObjectIntent.job_id,
            Job.status.in_(("running", "preparing")),
            Job.lease_until > utcnow(),
        )
    )
    intents = list(
        (
            await session.scalars(
                select(ObjectIntent)
                .where(
                    ObjectIntent.status.in_(("pending", "uploaded", "orphaned")),
                    ObjectIntent.updated_at < cutoff,
                    ~referenced,
                    ~active,
                )
                .order_by(ObjectIntent.updated_at)
                .limit(min(1000, max(1, limit)))
                .with_for_update(skip_locked=True)
            )
        ).all()
    )
    descriptors = [(row.id, row.object_key) for row in intents]
    for row in intents:
        row.status = "orphaned"
    await session.commit()
    removed = 0
    for identifier, key in descriptors:
        # HEAD/delete are both idempotent and run without any database transaction.
        if await asyncio.to_thread(get_storage().exists, key):
            await asyncio.to_thread(get_storage().delete, key)
        await session.execute(
            update(ObjectIntent)
            .where(
                ObjectIntent.id == identifier,
                ObjectIntent.status == "orphaned",
            )
            .values(status="deleted", updated_at=utcnow())
        )
        await session.commit()
        removed += 1
    return {"orphan_objects_deleted": removed}
