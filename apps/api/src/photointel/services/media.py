"""Bounded decoding and private derived files; originals are never modified."""

import asyncio
import hashlib
import io
import warnings
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import imagehash
import numpy as np
from PIL import ExifTags, Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.config import Settings
from photointel.errors import AppError, ErrorCode
from photointel.models import Asset, AssetMetadata, AssetResource
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
    processed = await asyncio.to_thread(
        decode_media, source_path(asset, settings), settings,
    )
    revision = processed.sha256
    if asset.source_metadata.get("fixture") or not asset.width or not asset.height:
        asset.width, asset.height = processed.width, processed.height
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
    storage = get_storage()
    for variant in processed.variants:
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
    asset.ingestion_status = "completed"
    asset.last_error = None
    await session.flush()
    return {"bytes_processed": processed.quality["file_bytes"],
            "variants": len(processed.variants),
            "representation_revision": revision}


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
        if resource.object_key:
            await asyncio.to_thread(get_storage().delete, resource.object_key)
            resource.status = "expired"
            objects += 1
    assets = (await session.scalars(select(Asset).where(
        Asset.ingestion_status == "completed",
        Asset.classification_status.in_((
            "completed", "not_configured", "not_applicable",
        )),
        Asset.updated_at < cutoff,
    ).order_by(Asset.updated_at).limit(limit))).all()
    for asset in assets:
        if asset.source_metadata.get("fixture"):
            continue
        try:
            cached = source_path(asset, settings)
        except AppError:
            continue
        await asyncio.to_thread(cached.unlink)
        caches += 1
    return {"temporary_objects_deleted": objects,
            "managed_download_caches_deleted": caches}
