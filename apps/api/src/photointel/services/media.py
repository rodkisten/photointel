"""Bounded decoding and private derived files; originals are never modified."""

import asyncio
import hashlib
import io
import math
import os
import tempfile
import warnings
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import imagehash
import numpy as np
from PIL import ExifTags, Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.config import Settings
from photointel.errors import AppError, ErrorCode
from photointel.models import Asset, AssetMetadata, AssetResource, utcnow
from photointel.storage import get_storage, object_key

# HEIF support is required and supplied by pillow-heif wheels on amd64 and arm64.
from pillow_heif import register_heif_opener

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
                try:
                    all_exif.update(exif.get_ifd(ExifTags.IFD.Exif))
                except (KeyError, TypeError, ValueError):
                    pass
                tags = {ExifTags.TAGS.get(k, str(k)): v for k, v in all_exif.items()}
                metadata: dict[str, Any] = {
                    "orientation": int(tags.get("Orientation", 1)),
                    "camera": str(tags.get("Model", ""))[:255] or None,
                    "lens": str(tags.get("LensModel", ""))[:255] or None,
                    "exposure": (str(tags["ExposureTime"])[:64]
                                 if "ExposureTime" in tags else None),
                    "iso": int(tags["ISOSpeedRatings"]) if isinstance(
                        tags.get("ISOSpeedRatings"), int
                    ) else None,
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
                            tags["DateTimeOriginal"], "%Y:%m:%d %H:%M:%S",
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
    except (OSError, ValueError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise AppError(ErrorCode.MEDIA_DECODE_FAILED,
                       "Imagem inválida ou codec indisponível", 422) from exc
    small = image.copy()
    small.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    gray = cv2.cvtColor(np.asarray(small), cv2.COLOR_RGB2GRAY)
    brightness = float(np.mean(gray) / 255)
    contrast = float(np.std(gray) / 255)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    quality = {
        "resolution": image.width * image.height,
        "resolution_megapixels": round(image.width * image.height / 1_000_000, 3),
        "brightness": round(brightness, 4), "contrast": round(contrast, 4),
        "sharpness": round(sharpness, 3),
        "sharpness_laplacian_variance": round(sharpness, 3),
        "score": round(
            0.5 * min(image.width * image.height / 24_000_000, 1)
            + 0.3 * min(sharpness / 1000, 1)
            + 0.2 * (1 - abs(brightness - 0.5) * 2), 4
        ),
        "underexposed_fraction": round(float(np.mean(gray < 12)), 4),
        "overexposed_fraction": round(float(np.mean(gray > 243)), 4),
        "file_bytes": path.stat().st_size,
        "compression": "source_codec_dependent",
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
        output = io.BytesIO()
        try:
            derived.save(output, format="WEBP", quality=settings.image_quality,
                         method=4, exif=b"")
            extension, mime = "webp", "image/webp"
        except (KeyError, OSError):
            output = io.BytesIO()
            derived.save(output, format="JPEG", quality=settings.image_quality, exif=b"")
            extension, mime = "jpg", "image/jpeg"
        variants.append(DerivedImage(variant, output.getvalue(), derived.width,
                                     derived.height, mime, extension))
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return ProcessedMedia(image.width, image.height, digest.hexdigest(),
                          str(imagehash.phash(image)), metadata, quality, variants)


def source_path(asset: Asset, settings: Settings) -> Path:
    """Only a manifest-owned relative path inside the configured cache is accepted."""
    root = (settings.temp_directory / "fixtures" if asset.source_metadata.get(
        "fixture", False
    ) else settings.icloud_download_directory).resolve()
    relative = asset.source_metadata.get("cache_relative_path")
    if not isinstance(relative, str):
        raise AppError(
            ErrorCode.MEDIA_DOWNLOAD_FAILED, "Manifesto sem representação local",
        )
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise AppError(ErrorCode.MEDIA_DOWNLOAD_FAILED,
                       "Representação local indisponível; reexecute a ingestão")
    return candidate


async def process_asset(
    session: AsyncSession, asset: Asset, settings: Settings,
) -> dict[str, Any]:
    if asset.media_type == "video":
        asset.ingestion_status = "completed"
        asset.classification_status = "not_applicable"
        return {"catalog_only": True}
    source = await asyncio.to_thread(source_path, asset, settings)
    processed = await asyncio.to_thread(decode_media, source, settings)
    revision = processed.sha256
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
    await store_variants(session, asset, processed.variants, revision)
    asset.ingestion_status = "completed"
    asset.source_metadata = {**asset.source_metadata, "processed_at": utcnow().isoformat()}
    asset.last_error = None
    await session.flush()
    return {"bytes_processed": processed.quality["file_bytes"],
            "variants": len(processed.variants),
            "representation_revision": revision}


async def store_variants(
    session: AsyncSession, asset: Asset, variants: list[DerivedImage], revision: str,
) -> None:
    storage = get_storage()
    for variant in variants:
        key = object_key(str(asset.id), revision, variant.variant, variant.extension)
        await asyncio.to_thread(storage.put, key, variant.data, variant.mime)
        resource = await session.scalar(select(AssetResource).where(
            AssetResource.asset_id == asset.id,
            AssetResource.resource_type == variant.variant,
            AssetResource.revision == revision,
        ))
        if resource is None:
            resource = AssetResource(asset_id=asset.id, resource_type=variant.variant,
                                     revision=revision)
            session.add(resource)
        resource.object_key, resource.mime_type = key, variant.mime
        resource.byte_size = len(variant.data)
        resource.width, resource.height = variant.width, variant.height
        resource.sha256 = hashlib.sha256(variant.data).hexdigest()
        resource.status = "available"
        resource.created_at = utcnow()


async def verify_media_stage(
    session: AsyncSession, asset: Asset, settings: Settings, stage: str,
    *, force: bool = False,
) -> dict[str, Any]:
    """Check the actual stage output; explicit reindex can rebuild managed derivatives."""
    if asset.media_type == "video":
        return {"catalog_only": True, "skipped": True}
    if asset.ingestion_status != "completed":
        raise AppError(ErrorCode.MEDIA_DECODE_FAILED, "Processamento de mídia pendente")
    complete = False
    if stage == "hash_generate":
        try:
            complete = (asset.sha256 is not None and len(asset.sha256) == 64
                        and asset.phash is not None and len(asset.phash) == 16)
            if complete:
                int(asset.sha256 or "", 16)
                int(asset.phash or "", 16)
        except ValueError:
            complete = False
    elif stage == "quality_analysis":
        fields = ("resolution", "brightness", "contrast", "sharpness", "score")
        complete = all(
            isinstance(asset.quality.get(field), (int, float))
            and math.isfinite(asset.quality[field]) for field in fields
        ) and asset.quality.get("heuristic") is True
    elif stage == "thumbnail_generate":
        rows = list((await session.scalars(select(AssetResource).where(
            AssetResource.asset_id == asset.id,
            AssetResource.revision == asset.representation_revision,
            AssetResource.resource_type.in_((
                "thumbnail_small", "thumbnail_medium", "preview_large",
            )), AssetResource.status == "available",
        ))).all())
        complete = len(rows) == 3 and all(row.object_key for row in rows)
        if complete:
            complete = all(await asyncio.gather(*[
                asyncio.to_thread(get_storage().exists, str(row.object_key)) for row in rows
            ]))
    else:
        raise ValueError("Unsupported media stage")
    if complete and not force:
        return {"verified": True, "shared_decode": True,
                "verification": "private_objects" if stage == "thumbnail_generate"
                else "persisted_metrics", "skipped": True}
    try:
        await asyncio.to_thread(source_path, asset, settings)
    except AppError:
        if stage == "hash_generate":
            raise AppError(
                ErrorCode.MEDIA_DECODE_FAILED,
                "Cache retirado: hash preservado; representação original não foi relida", 409,
            ) from None
        return await rebuild_from_preview(session, asset, settings, stage)
    result = await process_asset(session, asset, settings)
    return {**result, "regenerated": True}


async def rebuild_from_preview(
    session: AsyncSession, asset: Asset, settings: Settings, stage: str,
) -> dict[str, Any]:
    """Rebuild derived thumbnails/metrics without changing source identity or EXIF."""
    preview = await session.scalar(select(AssetResource).where(
        AssetResource.asset_id == asset.id,
        AssetResource.revision == asset.representation_revision,
        AssetResource.resource_type == "preview_large", AssetResource.status == "available",
    ))
    if preview is None or not preview.object_key:
        raise AppError(ErrorCode.MEDIA_DECODE_FAILED,
                       "Preview e cache indisponíveis; restaure o armazenamento privado", 409)
    data = await asyncio.to_thread(get_storage().get, preview.object_key)
    if len(data) > settings.media_max_bytes:
        raise AppError(ErrorCode.MEDIA_DECODE_FAILED, "Preview excede limite configurado")
    await asyncio.to_thread(
        settings.temp_directory.mkdir, parents=True, exist_ok=True, mode=0o700,
    )

    def decode_preview() -> ProcessedMedia:
        with tempfile.NamedTemporaryFile(dir=settings.temp_directory, suffix=".image") as handle:
            os.chmod(handle.name, 0o600)
            handle.write(data)
            handle.flush()
            return decode_media(Path(handle.name), settings)

    processed = await asyncio.to_thread(decode_preview)
    if stage == "thumbnail_generate":
        await store_variants(session, asset, [
            variant for variant in processed.variants if variant.variant != "preview_large"
        ], asset.representation_revision)
    else:
        asset.quality = {**processed.quality, "analysis_source": "retained_preview",
                         "analysis_input_revision": asset.representation_revision}
    return {"regenerated": True, "source": "retained_preview",
            "source_identity_preserved": True, "bytes_processed": len(data)}


async def cleanup_temporary_media(
    session: AsyncSession, settings: Settings, limit: int = 100,
) -> dict[str, int]:
    """Retire only derived inference objects and completed managed download caches.

    Catalog records, previews, fixture sources, and every Apple resource are retained.
    Reindexing can use preview_large after the inference input expires.
    """
    from datetime import timedelta
    cutoff = datetime.now(UTC) - timedelta(hours=settings.temporary_retention_hours)
    resources = (await session.scalars(select(AssetResource).join(
        Asset, Asset.id == AssetResource.asset_id,
    ).where(
        AssetResource.resource_type == "inference_input",
        AssetResource.status == "available", AssetResource.created_at < cutoff,
        Asset.ingestion_status == "completed", Asset.classification_status == "completed",
        Asset.last_successful_inference.is_not(None),
    ).order_by(AssetResource.created_at).limit(limit))).all()
    objects = caches = 0
    for resource in resources:
        acquired = await session.scalar(text("SELECT pg_try_advisory_xact_lock(:key)"), {
            "key": int.from_bytes(resource.asset_id.bytes[:8], "big", signed=True),
        })
        if not acquired:
            continue
        if resource.object_key:
            await asyncio.to_thread(get_storage().delete, resource.object_key)
            resource.status = "expired"
            objects += 1
    assets = (await session.scalars(select(Asset).where(
        Asset.ingestion_status == "completed",
        Asset.classification_status.in_((
            "completed", "not_configured", "not_applicable",
        )),
        Asset.source_metadata["fixture"].as_boolean().is_not(True),
        Asset.source_metadata["cache_retired_at"].as_string().is_(None),
        Asset.source_metadata["processed_at"].as_string() < cutoff.isoformat(),
    ).order_by(Asset.updated_at).limit(limit))).all()
    for asset in assets:
        acquired = await session.scalar(text("SELECT pg_try_advisory_xact_lock(:key)"), {
            "key": int.from_bytes(asset.id.bytes[:8], "big", signed=True),
        })
        if not acquired:
            continue
        preview = await session.scalar(select(AssetResource).where(
            AssetResource.asset_id == asset.id,
            AssetResource.revision == asset.representation_revision,
            AssetResource.resource_type == "preview_large",
            AssetResource.status == "available",
        ))
        # Keep the cache if the last persistent preview has not survived storage.
        if (preview is None or not preview.object_key
                or not await asyncio.to_thread(get_storage().exists, preview.object_key)):
            continue
        try:
            cached = await asyncio.to_thread(source_path, asset, settings)
        except AppError:
            cached = None
        if cached:
            await asyncio.to_thread(cached.unlink, missing_ok=True)
            caches += 1
        asset.source_metadata = {
            **asset.source_metadata, "cache_retired_at": utcnow().isoformat(),
        }
    return {"temporary_objects_deleted": objects,
            "managed_download_caches_deleted": caches}
